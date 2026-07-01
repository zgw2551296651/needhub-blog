# Redis 分布式锁与缓存一致性——Redisson 实战指南

> 本文从分布式锁的基本原理出发，深入剖析 Redisson 的核心实现、WatchDog 续期机制、RedLock 争议，并系统梳理缓存与数据库一致性的工程方案。包含大量 Java 代码和 Lua 脚本，适合中高级开发者与架构师阅读。

## 引言

在分布式系统中，多个服务实例并发访问共享资源时，必须通过**分布式锁**来保证互斥性。这是分布式系统中最基础也最容易被误用的组件之一。在单体应用中，一个简单的 `synchronized` 或 `ReentrantLock` 就能解决并发问题；但在分布式环境下，多个 JVM 进程运行在不同的物理机器上，本地锁完全失效，必须借助外部中间件来实现跨进程的互斥控制。

Redis 因其高性能和简单的 API，成为实现分布式锁的主流选择之一。相比 ZooKeeper 的强一致性但较低吞吐量，Redis 分布式锁在性能上有数量级的优势。然而，看似简单的 `SETNX` 背后隐藏着诸多陷阱：锁误释放、TTL 不可控、主从切换丢锁、时钟漂移……任何一个疏忽都可能导致生产事故，轻则数据不一致，重则资损。

本文将从原理到实战，完整拆解 Redis 分布式锁的每一个细节，并延伸至缓存一致性的终极难题。文章不仅介绍"怎么做"，更深入分析"为什么这么做"以及"什么场景下不应该这么做"，帮助读者建立对分布式锁的全面认知。

```
  分布式锁技术全景
  ┌──────────────────────────────────────────────────────────┐
  │                                                          │
  │   基础实现           Redisson 增强          一致性方案     │
  │   ────────          ─────────────          ──────────    │
  │   SET NX EX         可重入锁              先更DB后删缓存  │
  │   Lua 安全释放       WatchDog续期          延迟双删       │
  │   UUID防误解锁       RedLock(争议)         Canal+Binlog   │
  │                     lock vs tryLock       读写穿透       │
  │                                          Write Behind   │
  └──────────────────────────────────────────────────────────┘
```

## 一、分布式锁的四大要求

### 1.1 互斥性（Mutual Exclusion）

同一时刻，只能有一个客户端持有锁。这是分布式锁最基本的要求，相当于单线程中的 `synchronized`。

### 1.2 安全性（Safety）

只有锁的持有者才能释放锁。防止客户端 A 误删客户端 B 的锁——在分布式环境中，这需要通过唯一标识（如 UUID + threadId）配合 Lua 脚本原子校验来实现。

### 1.3 容错性（Fault Tolerance）

锁必须有自动过期机制（TTL），防止持有者崩溃后锁永远不释放，导致死锁。所有客户端都应有能力获取锁（在锁释放或过期后）。

### 1.4 性能（Performance）

加锁/解锁操作应尽量快，不成为系统瓶颈。Redis 分布式锁的优势正在于此——单次 SETNX 操作耗时微秒级。

## 二、基本实现

### 2.1 加锁：SET NX EX

```bash
# 原子性加锁（推荐写法）
SET lock_key unique_value NX EX 30

# NX：仅当 key 不存在时设置（互斥性）
# EX 30：30秒过期（容错性）
# unique_value：唯一标识（安全性基础）
```

**为什么必须用 `SET NX EX` 而不是 `SETNX` + `EXPIRE`？**

```
  SETNX + EXPIRE 的问题：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  Client A:                                       │
  │  1. SETNX lock_key value_A → OK（获取锁成功）     │
  │  2. ──── 此处发生崩溃/网络中断 ────               │
  │  3. EXPIRE lock_key 30 → 未执行！                 │
  │                                                  │
  │  结果：lock_key 永远存在，所有客户端都无法获取锁    │
  │  = 死锁                                          │
  │                                                  │
  │  SET NX EX 是原子操作，不存在这个问题              │
  └──────────────────────────────────────────────────┘
```

### 2.2 解锁：Lua 脚本安全释放

```lua
-- 安全解锁 Lua 脚本
-- KEYS[1] = lock_key
-- ARGV[1] = unique_value（加锁时设置的值）

if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
```

**为什么必须用 Lua 脚本而不是 GET + DEL？**

```
  GET + DEL 的竞态问题：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  Client A:                                      │
  │  1. GET lock_key → "value_A"                    │
  │  2. ──── 此时锁过期 ────                          │
  │                                                  │
  │  Client B:                                      │
  │  3. SETNX lock_key "value_B" NX EX 30 → OK     │
  │     （B 获取了锁）                                │
  │                                                  │
  │  Client A:                                      │
  │  4. 判断 "value_A" == "value_A" → true           │
  │  5. DEL lock_key → 删除了 B 的锁！               │
  │                                                  │
  │  Lua 脚本在 Redis 单线程中原子执行                │
  │  GET 和 DEL 之间不会插入其他命令                  │
  └──────────────────────────────────────────────────┘
```

### 2.3 Java 基础实现

```java
public class SimpleRedisLock {

    private final StringRedisTemplate redisTemplate;
    private final String lockKey;
    private final String lockValue;

    // 预编译 Lua 脚本（避免每次传输脚本字符串）
    private static final DefaultRedisScript<Long> UNLOCK_SCRIPT;
    static {
        UNLOCK_SCRIPT = new DefaultRedisScript<>();
        UNLOCK_SCRIPT.setScriptText(
            "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
            "    return redis.call('DEL', KEYS[1]) " +
            "else " +
            "    return 0 " +
            "end"
        );
        UNLOCK_SCRIPT.setResultType(Long.class);
    }

    public SimpleRedisLock(StringRedisTemplate redisTemplate, String lockKey) {
        this.redisTemplate = redisTemplate;
        this.lockKey = lockKey;
        // UUID + 线程ID 保证全局唯一
        this.lockValue = UUID.randomUUID() + ":" + Thread.currentThread().getId();
    }

    /**
     * 尝试加锁
     * @param ttlSeconds 锁的过期时间（秒）
     * @return true=加锁成功
     */
    public boolean tryLock(long ttlSeconds) {
        Boolean result = redisTemplate.opsForValue()
            .setIfAbsent(lockKey, lockValue, ttlSeconds, TimeUnit.SECONDS);
        return Boolean.TRUE.equals(result);
    }

    /**
     * 释放锁
     * @return true=释放成功（自己是持有者）
     */
    public boolean unlock() {
        Long result = redisTemplate.execute(
            UNLOCK_SCRIPT,
            Collections.singletonList(lockKey),
            lockValue
        );
        return result != null && result == 1;
    }
}

// 使用示例
SimpleRedisLock lock = new SimpleRedisLock(redisTemplate, "order:lock:1001");
try {
    if (lock.tryLock(30)) {
        // 执行业务逻辑（扣减库存、创建订单等）
        processOrder();
    } else {
        // 获取锁失败，降级处理
        throw new BizException("系统繁忙，请稍后重试");
    }
} finally {
    lock.unlock();
}
```

## 三、可重入锁

### 3.1 设计思路

可重入锁允许同一个线程多次获取同一把锁而不被阻塞（类似 Java 的 `ReentrantLock`）。核心设计：

```
  可重入锁的值结构
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  使用 Hash 结构存储：                              │
  │  Key: lock:order:1001                            │
  │  Field: {uuid}:{threadId}                        │
  │  Value: 重入计数 count                            │
  │                                                  │
  │  加锁流程：                                       │
  │  1. 如果 key 不存在 → HSET count=1, 设置 TTL     │
  │  2. 如果 field 已存在 → HINCRBY count+1          │
  │  3. 如果 field 不存在且 key 存在 → 返回剩余TTL    │
  │     （其他线程持有锁，需要等待）                    │
  │                                                  │
  │  解锁流程：                                       │
  │  1. HINCRBY count-1                              │
  │  2. 如果 count > 0 → 仍有重入，不删除             │
  │  3. 如果 count = 0 → DEL key（物理删除）          │
  └──────────────────────────────────────────────────┘
```

### 3.2 可重入加锁 Lua 脚本

```lua
-- 可重入加锁
-- KEYS[1] = lock_key
-- ARGV[1] = unique_thread_id (uuid:threadId)
-- ARGV[2] = ttl_ms (毫秒)

-- 锁不存在，首次加锁
if redis.call('EXISTS', KEYS[1]) == 0 then
    redis.call('HSET', KEYS[1], ARGV[1], 1)
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return nil  -- nil 表示加锁成功
end

-- 锁已存在，检查是否是同一个线程
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
    -- 重入计数 +1
    redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
    redis.call('PEXPIRE', KEYS[1], ARGV[2])  -- 刷新 TTL
    return nil
end

-- 其他线程持有锁，返回剩余 TTL（毫秒）
return redis.call('PTTL', KEYS[1])
```

### 3.3 可重入解锁 Lua 脚本

```lua
-- 可重入解锁
-- KEYS[1] = lock_key
-- ARGV[1] = unique_thread_id

-- 锁不存在（已过期），返回 0
if redis.call('EXISTS', KEYS[1]) == 0 then
    return 0
end

-- 不是锁的持有者，返回 0
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
    return 0
end

-- 重入计数 -1
local count = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)

if count > 0 then
    -- 仍有重入，刷新 TTL 但不删除
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 1  -- 表示部分释放
else
    -- 完全释放，删除锁
    redis.call('DEL', KEYS[1])
    return 2  -- 表示完全释放
end
```

## 四、五大生产陷阱

### 4.1 陷阱一：误解锁（释放别人的锁）

```
  场景：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  Client A: SET lock "A" NX EX 5                 │
  │  Client A: 业务执行 8 秒...锁已过期！             │
  │                                                  │
  │  Client B: SET lock "B" NX EX 5 → 成功获取锁    │
  │                                                  │
  │  Client A: DEL lock → 删除了 B 的锁！            │
  │                                                  │
  │  解决方案：UUID + Lua 验证                        │
  │  只有 GET lock == 自己的 UUID 时才执行 DEL        │
  └──────────────────────────────────────────────────┘
```

### 4.2 陷阱二：TTL 不可控（业务未完成锁已过期）

```
  场景：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  设置 TTL = 10秒                                 │
  │  但业务执行需要 30秒（网络抖动、GC停顿）           │
  │  10秒后锁过期 → 其他线程获取锁 → 并发冲突          │
  │                                                  │
  │  TTL 设太大 → 持有者崩溃后其他线程等太久           │
  │  TTL 设太小 → 业务还没执行完锁就过期了             │
  │                                                  │
  │  解决方案：Watch Dog 自动续期                      │
  │  只要持有者还活着，就持续续期                       │
  └──────────────────────────────────────────────────┘
```

### 4.3 陷阱三：主从异步复制导致丢锁

```
  场景：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  Client A → Master: SET lock "A" NX EX 30       │
  │  Master → Client A: OK（加锁成功）               │
  │                                                  │
  │  Master ──异步复制──→ Slave                      │
  │         （锁数据还没同步到 Slave）                 │
  │                                                  │
  │  Master 宕机！                                   │
  │  Slave 被提升为新 Master（没有 lock 数据）        │
  │                                                  │
  │  Client B → 新Master: SET lock "B" NX EX 30     │
  │  新Master → Client B: OK（A 和 B 同时持有锁！）   │
  │                                                  │
  │  解决方案：RedLock 多节点方案                      │
  │  或接受风险 + 业务层兜底                          │
  └──────────────────────────────────────────────────┘
```

### 4.4 陷阱四：网络分区

```
  场景：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  Client A 持有锁，正在执行业务                    │
  │  Client A 与 Redis 之间网络分区                   │
  │                                                  │
  │  Client A 的续期请求无法到达 Redis                │
  │  锁 TTL 到期后自动释放                            │
  │                                                  │
  │  Client B 获取到锁，开始执行业务                  │
  │  Client A 网络恢复，继续执行（以为还持有锁）       │
  │                                                  │
  │  解决方案：                                       │
  │  1. 业务层做幂等检查                              │
  │  2. 使用 fencing token（单调递增令牌）             │
  │  3. DB 唯一约束兜底                              │
  └──────────────────────────────────────────────────┘
```

### 4.5 陷阱五：时钟漂移

```
  场景：
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │  Redis 服务器时钟突然跳变（NTP 同步）              │
  │  例如：系统时间向前跳了 60 秒                      │
  │                                                  │
  │  所有设置了 TTL 的锁瞬间过期                       │
  │  多个客户端同时认为锁已释放                        │
  │  并发获取锁 → 互斥性被破坏                        │
  │                                                  │
  │  解决方案：                                       │
  │  1. 服务器禁止使用 NTP 强制同步，使用 chrony 平滑  │
  │  2. TTL 设置时增加缓冲时间                        │
  │  3. 业务层增加状态校验                             │
  └──────────────────────────────────────────────────┘
```

## 五、Redisson 核心原理

### 5.1 整体架构

Redisson 是目前 Java 生态中最成熟的 Redis 客户端之一，其分布式锁实现是业界标杆。

```
  Redisson 分布式锁架构
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  应用层                                               │
  │  ┌──────────────────────────────────────────┐        │
  │  │ RLock lock = redisson.getLock("myLock"); │        │
  │  │ lock.lock();                              │        │
  │  │ // 业务逻辑                               │        │
  │  │ lock.unlock();                            │        │
  │  └──────────────────────────────────────────┘        │
  │                     │                                │
  │                     ▼                                │
  │  Redisson 锁核心                                       │
  │  ┌──────────────────────────────────────────┐        │
  │  │                                          │        │
  │  │  1. Hash 结构: lockName → {uuid:threadId} │        │
  │  │     value = 重入次数 count                 │        │
  │  │                                          │        │
  │  │  2. Lua 脚本: 加锁/解锁/续期 原子操作       │        │
  │  │                                          │        │
  │  │  3. WatchDog: 后台线程自动续期              │        │
  │  │     每 10s 检查一次 (30s / 3)              │        │
  │  │                                          │        │
  │  │  4. Pub/Sub: 锁释放时通知等待线程           │        │
  │  └──────────────────────────────────────────┘        │
  │                     │                                │
  │                     ▼                                │
  │  Redis Server                                         │
  │  ┌──────────────────────────────────────────┐        │
  │  │  HSET myLock uuid:thread-1 1             │        │
  │  │  PEXPIRE myLock 30000                    │        │
  │  └──────────────────────────────────────────┘        │
  └──────────────────────────────────────────────────────┘
```

### 5.2 加锁 Lua 脚本（Redisson 实际逻辑）

```lua
-- Redisson 加锁脚本（简化版）
-- KEYS[1] = lockName
-- ARGV[1] = leaseTime (ms)
-- ARGV[2] = threadIdentifier (uuid:threadId)

-- 1. 锁不存在 → 创建锁
if (redis.call('exists', KEYS[1]) == 0) then
    redis.call('hset', KEYS[1], ARGV[2], 1);
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return nil;
end;

-- 2. 锁存在且是同一线程 → 重入计数+1
if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('hincrby', KEYS[1], ARGV[2], 1);
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return nil;
end;

-- 3. 锁被其他线程持有 → 返回剩余 TTL
return redis.call('pttl', KEYS[1]);
```

## 六、WatchDog 自动续期机制

### 6.1 工作原理

WatchDog 是 Redisson 解决"TTL 不可控"问题的核心机制。当使用 `lock()` 或 `lock(-1)` 时（不指定 leaseTime），WatchDog 会自动启动：

```
  WatchDog 续期流程
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  1. 加锁成功后，调用 scheduleExpirationRenewal()       │
  │                                                      │
  │  2. 在 EXPIRATION_RENEWAL_MAP（ConcurrentHashMap）    │
  │     中注册续期任务，key = threadId                     │
  │                                                      │
  │  3. 创建 Netty HashedWheelTimer 定时任务               │
  │     延迟 = internalLockLeaseTime / 3                  │
  │     默认 internalLockLeaseTime = 30s                  │
  │     所以每 10s 续期一次                                │
  │                                                      │
  │  4. TimerTask 执行续期 Lua 脚本：                      │
  │     检查 HEXISTS lockName threadId                    │
  │     如果存在 → PEXPIRE lockName 30000（续期到30秒）    │
  │     如果不存在 → 取消续期任务                          │
  │                                                      │
  │  时间线：                                              │
  │  0s          10s         20s         30s              │
  │  │           │           │           │                │
  │  加锁        续期→30s    续期→30s    续期→30s         │
  │  TTL=30s     TTL重置     TTL重置     TTL重置          │
  │                                                      │
  │  如果持有者崩溃：                                      │
  │  WatchDog 线程随之停止                                 │
  │  最后一次续期后 30s，锁自动过期                        │
  └──────────────────────────────────────────────────────┘
```

### 6.2 续期 Lua 脚本

```lua
-- WatchDog 续期脚本
-- KEYS[1] = lockName
-- ARGV[1] = internalLockLeaseTime (ms)
-- ARGV[2] = threadIdentifier

-- 只有锁的持有者才续期
if (redis.call('hexists', KEYS[1], ARGV[2]) == 1) then
    redis.call('pexpire', KEYS[1], ARGV[1]);
    return 1;
end;
return 0;
```

### 6.3 Java 源码要点

```java
// Redisson 续期核心代码（简化）
private void renewExpiration() {
    // 创建定时任务
    Timeout task = commandExecutor.getConnectionManager()
        .newTimeout(new TimerTask() {
            @Override
            public void run(Timeout timeout) {
                // 执行续期 Lua 脚本
                RFuture<Boolean> future = renewExpirationAsync(threadId);
                future.onComplete((res, e) -> {
                    if (res) {
                        // 续期成功，调度下一次续期
                        renewExpiration(); // 递归调度
                    } else {
                        // 锁已不存在，取消续期
                        cancelExpirationRenewal(threadId);
                    }
                });
            }
        }, internalLockLeaseTime / 3, TimeUnit.MILLISECONDS);
    // internalLockLeaseTime 默认 30000ms
    // 所以续期间隔 = 30000 / 3 = 10000ms = 10秒
}
```

## 七、lock() vs tryLock()

### 7.1 lock()：阻塞无限等待

```java
RLock lock = redisson.getLock("order:lock:1001");

// 无限等待，直到获取到锁
// 内部通过 Pub/Sub 监听锁释放事件，被唤醒后重试
lock.lock();
try {
    processOrder();
} finally {
    lock.unlock();
}

// 带超时时间的 lock
lock.lock(10, TimeUnit.SECONDS);  // 最多等10秒
// 注意：这里 10s 是等待超时，不是锁的 TTL
// 锁的 TTL 仍由 WatchDog 管理（默认30s）
```

**lock() 内部流程**：
1. 执行加锁 Lua 脚本
2. 如果返回 nil → 加锁成功
3. 如果返回 TTL > 0 → 订阅锁释放的 Pub/Sub 频道
4. 收到释放通知后，重新尝试加锁
5. 循环直到成功或超时

### 7.2 tryLock()：超时放弃

```java
RLock lock = redisson.getLock("order:lock:1001");

// tryLock(waitTime, leaseTime, unit)
// waitTime: 最大等待时间
// leaseTime: 锁的 TTL（指定后 WatchDog 不启动）
boolean acquired = lock.tryLock(5, 30, TimeUnit.SECONDS);

if (acquired) {
    try {
        processOrder();
    } finally {
        lock.unlock();
    }
} else {
    // 5秒内未获取到锁，走降级逻辑
    log.warn("获取锁超时，执行降级策略");
    fallbackProcess();
}
```

### 7.3 使用场景对比

```
  ┌────────────────────────────────────────────────────────┐
  │ 方法         行为            适用场景                    │
  │ ────         ────            ────────                   │
  │ lock()       无限等待        必须执行的业务              │
  │                             (如核心交易链路)             │
  │                                                        │
  │ lock(t)      等待t秒后放弃   有一定容忍度但不能无限等     │
  │                                                        │
  │ tryLock()    立即返回        可接受失败的场景             │
  │                             (如库存预扣、幂等校验)       │
  │                                                        │
  │ tryLock(w,l) 等待w秒,       需要精确控制等待和TTL        │
  │              锁TTL=l秒      (注意：指定l后无WatchDog)    │
  └────────────────────────────────────────────────────────┘
```

## 八、RedLock 算法与争议

### 8.1 RedLock 算法

RedLock 是 Redis 作者 Antirez 提出的多节点分布式锁方案，用于解决主从切换丢锁的问题：

```
  RedLock 算法流程
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  部署 N 个独立的 Redis 节点（通常 N=5）               │
  │  每个节点之间无数据复制关系                            │
  │                                                      │
  │  加锁步骤：                                          │
  │  1. 获取当前时间戳 T1                                │
  │  2. 依次向 N 个节点尝试加锁（使用相同的 key 和 value） │
  │     每个节点设置较短的超时（如 5ms）                   │
  │  3. 计算加锁耗时 T2 = 当前时间 - T1                  │
  │  4. 统计加锁成功数 count                              │
  │  5. 如果 count >= N/2 + 1（多数派）                   │
  │     且 T2 < TTL                                      │
  │     → 加锁成功，有效 TTL = TTL - T2                   │
  │  6. 否则 → 加锁失败，向所有节点发送解锁请求            │
  │     （包括那些返回失败的节点，防止网络延迟导致的误判）   │
  │                                                      │
  │  示例（N=5）：                                       │
  │  Node1: OK    Node2: OK    Node3: FAIL               │
  │  Node4: OK    Node5: OK                              │
  │  count = 4 >= 3 (5/2+1) → 加锁成功                   │
  └──────────────────────────────────────────────────────┘
```

### 8.2 Martin Kleppmann 的批评

分布式系统专家 Martin Kleppmann 发表了著名文章《How to do distributed locking》，指出 RedLock 的根本缺陷：

```
  RedLock 的核心问题
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  1. 没有 fencing token 机制                          │
  │     - 锁过期后客户端可能不知道自己已经丢锁            │
  │     - 应该使用单调递增的 fencing token                │
  │     - 存储层通过 token 拒绝过期客户端的写入           │
  │                                                      │
  │  2. 依赖时钟假设                                     │
  │     - RedLock 假设所有节点时钟同步                    │
  │     - 现实中时钟跳变、NTP 同步都可能导致锁失效        │
  │     - 分布式系统不应依赖时钟同步                      │
  │                                                      │
  │  3. 进程暂停问题（GC STW）                            │
  │     - 客户端获取锁后发生长时间 GC                      │
  │     - GC 结束后锁已过期但客户端不知道                  │
  │     - 继续操作共享资源 → 数据不一致                   │
  │                                                      │
  │  Antirez 的反驳：                                    │
  │  - RedLock 不是为了"效率"（efficiency）              │
  │  - 而是为了"安全性"（safety）在大多数情况下足够好     │
  │  - 自动过期本身就是一种容错机制                       │
  └──────────────────────────────────────────────────────┘
```

### 8.3 Redisson 的 RedLock 实现与弃用

```java
// Redisson 的 RedLock 实现
RLock lock1 = redisson1.getLock("lock1");
RLock lock2 = redisson2.getLock("lock2");
RLock lock3 = redisson3.getLock("lock3");

RedissonRedLock redLock = new RedissonRedLock(lock1, lock2, lock3);
redLock.lock();
try {
    // 业务逻辑
} finally {
    redLock.unlock();
}

// 注意：Redisson 3.17.6+ 已将 RedissonRedLock 标记为 @Deprecated
// 官方建议回归单实例锁 + 业务层保护
```

## 九、推荐替代方案

### 9.1 单实例锁 + 业务层保护（推荐方案）

```
  生产推荐架构
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  第一层：Redis 单实例分布式锁                         │
  │  - Redisson lock + WatchDog                           │
  │  - 解决 95% 的并发互斥问题                            │
  │                                                      │
  │  第二层：业务状态检查                                  │
  │  - 操作前检查业务状态（如订单是否已处理）              │
  │  - 防止锁失效后的重复操作                              │
  │                                                      │
  │  第三层：数据库唯一约束                                │
  │  - UNIQUE KEY 防止重复数据                            │
  │  - 乐观锁 version 字段                                │
  │                                                      │
  │  第四层：对账任务                                      │
  │  - 定期比对 Redis 缓存与 DB 数据                      │
  │  - 发现不一致自动告警和修复                            │
  └──────────────────────────────────────────────────────┘
```

```java
// 多层保护示例
public void processOrder(Long orderId) {
    RLock lock = redisson.getLock("order:lock:" + orderId);
    boolean acquired = lock.tryLock(5, 30, TimeUnit.SECONDS);
    if (!acquired) {
        throw new BizException("系统繁忙");
    }
    try {
        // 第一层保护：业务状态检查
        Order order = orderRepository.findById(orderId);
        if (order.getStatus() != OrderStatus.PENDING) {
            log.info("订单已处理，跳过: {}", orderId);
            return;
        }

        // 执行业务逻辑
        order.setStatus(OrderStatus.PROCESSING);
        orderRepository.save(order);  // 第二层保护：DB唯一约束
        inventoryService.deduct(order.getSkuId(), order.getQuantity());
    } finally {
        lock.unlock();
    }
}
```

### 9.2 强一致性场景用 ZooKeeper

```
  Redis vs ZooKeeper 分布式锁对比
  ┌────────────────────────────────────────────────────────┐
  │                Redis 锁              ZooKeeper 锁       │
  │                ────────              ────────────       │
  │ 一致性模型      最终一致性            强一致性            │
  │ 性能           极高(10w+ QPS)       中等(~1w QPS)      │
  │ 锁释放         TTL自动过期           Session超时         │
  │ 公平性         非公平               公平(临时顺序节点)    │
  │ 可重入         支持(Redisson)        支持(Curator)       │
  │ 主从切换       可能丢锁             不丢锁               │
  │ 时钟依赖       有                   无                  │
  │                                                        │
  │ 选型建议：                                              │
  │ - 高并发、允许极小概率不一致 → Redis                     │
  │ - 金融级、强一致性要求 → ZooKeeper                       │
  │ - 不确定 → Redis + 业务层兜底（性价比最高）              │
  └────────────────────────────────────────────────────────┘
```

## 十、SETNX 原子性与 Redis 事务

### 10.1 SETNX 的原子性保证

```
  Redis 单线程事件循环保证原子性
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  客户端请求进入事件队列：                               │
  │  ┌──┬──┬──┬──┬──┬──┬──┐                             │
  │  │C1│C2│C3│C4│C5│C6│C7│ ← 命令队列                  │
  │  └──┴──┴──┴──┴──┴──┴──┘                             │
  │          │                                           │
  │          ▼                                           │
  │  ┌──────────────┐                                   │
  │  │  主线程串行    │                                   │
  │  │  逐条执行     │                                   │
  │  │  无并发竞争   │                                   │
  │  └──────────────┘                                   │
  │                                                      │
  │  SETNX 是单条命令 → 天然是原子的                      │
  │  两条命令之间可能被其他客户端命令插入                    │
  │                                                      │
  │  SETNX + EXPIRE = 两条命令 → 非原子！                 │
  │  SET key value NX EX = 一条命令 → 原子！              │
  └──────────────────────────────────────────────────────┘
```

### 10.2 SETNX vs SETEX 对比

```
  ┌────────────────────────────────────────────────────────┐
  │ 命令                        原子性    用途              │
  │ ────                        ──────    ────              │
  │ SETNX key value             是        加锁（无过期）    │
  │ SETEX key seconds value     是        设置+过期         │
  │ SET key value NX EX s       是        加锁+过期(推荐)   │
  │ SETNX + EXPIRE              否！      已弃用            │
  │ GETSET key value            是        原子替换          │
  └────────────────────────────────────────────────────────┘
```

### 10.3 Redis 事务

```bash
# 基本事务（MULTI/EXEC）
MULTI                    # 开启事务
SET key1 "value1"        # 命令入队（不执行）
SET key2 "value2"        # 命令入队
INCR key3                # 命令入队
EXEC                     # 一次性执行队列中所有命令

# 取消事务
DISCARD                  # 清空命令队列

# 乐观锁（WATCH）
WATCH key1               # 监视 key1
# ... 如果 key1 在 EXEC 前被其他客户端修改
MULTI
SET key1 "new_value"
EXEC                     # 返回 nil（事务被拒绝）
```

**Redis 事务的局限性**：

```
  Redis 事务 vs 关系型数据库事务
  ┌────────────────────────────────────────────────────────┐
  │ 特性          Redis 事务          RDBMS 事务            │
  │ ────          ────────            ────────              │
  │ 原子性        不支持回滚           支持回滚              │
  │               (某条命令失败        (ROLLBACK 撤销所有)   │
  │                其他仍执行)                              │
  │ 隔离性        天然隔离             MVCC/锁               │
  │               (单线程串行)                              │
  │ 持久性        取决于持久化配置      默认保证              │
  │ 一致性        部分保证             完全保证              │
  └────────────────────────────────────────────────────────┘

  不支持回滚的原因：
  Redis 认为命令语法错误应该在入队时就被检测到
  运行时错误（如类型不匹配）是编程错误
  不应该在生产中出现，不值得增加回滚的复杂性
```

### 10.4 Pipeline 与 Lua 脚本

```java
// Pipeline：批量发送命令，减少网络 RTT（非原子）
List<Object> results = redisTemplate.executePipelined(
    (RedisCallback<Object>) connection -> {
        connection.set("key1".getBytes(), "value1".getBytes());
        connection.set("key2".getBytes(), "value2".getBytes());
        connection.get("key1".getBytes());
        return null;
    }
);

// Lua 脚本：原子执行多个命令（优于事务）
String luaScript =
    "local v = redis.call('GET', KEYS[1]) " +
    "if v == false then " +
    "    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) " +
    "    return 1 " +
    "end " +
    "if tonumber(v) < tonumber(ARGV[3]) then " +
    "    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]) " +
    "    return 1 " +
    "end " +
    "return 0";

DefaultRedisScript<Long> script = new DefaultRedisScript<>(luaScript, Long.class);
Long result = redisTemplate.execute(
    script,
    Collections.singletonList("rate:limit"),
    "1", "60", "100"
);
```

```
  Pipeline vs Lua vs Transaction 对比
  ┌────────────────────────────────────────────────────────┐
  │ 方式         原子性    性能     复杂度    适用场景       │
  │ ────         ──────    ────     ──────    ────────      │
  │ Pipeline     否        高       低        批量读写       │
  │ (减少RTT)                                              │
  │                                                        │
  │ Lua脚本      是        高       中        原子性复合操作 │
  │ (推荐)                                                 │
  │                                                        │
  │ Transaction  弱        中       低        简单条件执行   │
  │ (MULTI/EXEC)                                           │
  └────────────────────────────────────────────────────────┘
```

## 十一、缓存与数据库一致性

### 11.1 问题根因

```
  缓存一致性问题的根因
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  应用                                                │
  │   │                                                  │
  │   ├── 写操作 ──→ 数据库（MySQL）                     │
  │   │                                                  │
  │   └── 读/写 ──→ 缓存（Redis）                        │
  │                                                      │
  │  根本原因：                                           │
  │  数据库和缓存是两个独立的系统                           │
  │  无法通过一个分布式事务同时原子更新两者                  │
  │  无论采用什么策略，都存在短暂的不一致窗口               │
  │                                                      │
  │  目标：尽量缩小不一致窗口，保证最终一致性               │
  └──────────────────────────────────────────────────────┘
```

### 11.2 删除缓存 vs 更新缓存

```
  为什么推荐"删除缓存"而不是"更新缓存"？
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  更新缓存的问题：                                     │
  │  1. 并发写时，两个线程同时计算新值并写入缓存           │
  │     → 缓存值可能不一致                               │
  │  2. 写多读少时，每次写都更新缓存是浪费                 │
  │     → 还没被读就又被更新了                           │
  │  3. 缓存计算逻辑可能复杂（如关联查询）                │
  │     → 更新缓存增加了写操作的延迟                      │
  │                                                      │
  │  删除缓存的优势：                                     │
  │  1. 简单：DEL key 即可                                │
  │  2. 懒加载：下次读时从 DB 加载最新值                  │
  │  3. 避免并发写导致的不一致                            │
  │                                                      │
  │  结论：绝大多数场景推荐"删除缓存"                     │
  └──────────────────────────────────────────────────────┘
```

### 11.3 方案一：先更新 DB，后删除缓存

```
  Cache-Aside Pattern（旁路缓存模式）
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  写操作：                                            │
  │  1. UPDATE db SET price=99 WHERE id=1001             │
  │  2. DEL redis:product:1001                           │
  │                                                      │
  │  读操作：                                            │
  │  1. GET redis:product:1001                           │
  │  2. 如果 miss → SELECT * FROM product WHERE id=1001 │
  │  3. SET redis:product:1001 {结果} EX 3600            │
  │                                                      │
  │  不一致窗口分析：                                     │
  │  场景A：缓存恰好失效 + 并发读写                       │
  │  ┌─────────────────────────────────────────┐         │
  │  │ 读线程              写线程               │         │
  │  │ 1.GET cache→miss                        │         │
  │  │ 2.SELECT DB→old_value                   │         │
  │  │                     3.UPDATE DB→new     │         │
  │  │                     4.DEL cache         │         │
  │  │ 5.SET cache→old_value ← 写回旧值！      │         │
  │  └─────────────────────────────────────────┘         │
  │  此场景概率极低（需要缓存恰好过期+读写并发）           │
  │  且由于缓存有 TTL，最终会一致                          │
  └──────────────────────────────────────────────────────┘
```

### 11.4 方案二：延迟双删

```
  延迟双删策略
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  写操作：                                            │
  │  1. DEL redis:product:1001        （第一次删除缓存）  │
  │  2. UPDATE db SET price=99         （更新数据库）      │
  │  3. sleep(500ms)                   （延迟等待）       │
  │  4. DEL redis:product:1001        （第二次删除缓存）  │
  │                                                      │
  │  为什么需要延迟？                                     │
  │  步骤1删除后，可能有读线程正在从DB加载旧值             │
  │  延迟等待这些读线程完成写入缓存后                      │
  │  再删除一次，确保缓存中是最新值                        │
  │                                                      │
  │  缺点：                                               │
  │  1. 延迟时间难以精确确定                               │
  │  2. 增加了写操作的延迟                                │
  │  3. 第二次删除可能失败（无重试机制）                   │
  └──────────────────────────────────────────────────────┘
```

```java
// 延迟双删实现
public void updateProduct(Long productId, BigDecimal newPrice) {
    String cacheKey = "product:" + productId;

    // 第一次删除缓存
    redisTemplate.delete(cacheKey);

    // 更新数据库
    productRepository.updatePrice(productId, newPrice);

    // 延迟第二次删除（异步执行，不阻塞主流程）
    CompletableFuture.runAsync(() -> {
        try {
            Thread.sleep(500); // 延迟500ms
            redisTemplate.delete(cacheKey);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    });
}
```

### 11.5 方案三：Canal 监听 Binlog 异步失效（推荐）

```
  Canal + Binlog 方案
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  应用                    MySQL                  Redis │
  │   │                       │                      │   │
  │   │ UPDATE product        │                      │   │
  │   │──────────────────────→│                      │   │
  │   │                       │                      │   │
  │   │                       │ binlog               │   │
  │   │                       │──────→ Canal Server  │   │
  │   │                       │       (解析binlog)   │   │
  │   │                       │          │           │   │
  │   │                       │          ▼           │   │
  │   │                       │    MQ (Kafka/RocketMQ)   │
  │   │                       │          │           │   │
  │   │                       │          ▼           │   │
  │   │                       │    缓存失效消费者      │   │
  │   │                       │          │           │   │
  │   │                       │    DEL cache ────────→│   │
  │   │                       │                      │   │
  │                                                      │
  │  优势：                                               │
  │  1. 业务代码零侵入（不需要在业务中操作缓存）           │
  │  2. 异步执行，不影响写操作延迟                        │
  │  3. 可靠：binlog 是 MySQL 的持久化日志               │
  │  4. 可重试：消息队列保证最终一致性                     │
  │                                                      │
  │  劣势：                                               │
  │  1. 增加系统复杂度（Canal + MQ）                      │
  │  2. 有不一致延迟（binlog解析 + 消费）                 │
  └──────────────────────────────────────────────────────┘
```

### 11.6 读写穿透与 Write Behind

```
  Read/Write Through（读写穿透）
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  应用不直接与缓存或DB交互                              │
  │  所有操作通过缓存层代理                               │
  │                                                      │
  │  读穿透：                                            │
  │  应用 → 缓存层 → (miss) → 缓存层从DB加载 → 写入缓存  │
  │                                                      │
  │  写穿透：                                            │
  │  应用 → 缓存层 → 更新缓存 → 同步更新DB               │
  │                                                      │
  │                                                      │
  │  Write Behind（Write Back）                           │
  │  ┌──────────────────────────────────────────┐        │
  │  │                                          │        │
  │  │  应用 → 缓存层（只更新缓存，立即返回）     │        │
  │  │              │                           │        │
  │  │              ▼                           │        │
  │  │         异步批量写入 DB                   │        │
  │  │         (合并多次写操作，减少DB压力)       │        │
  │  │                                          │        │
  │  │  优势：写操作极快                          │        │
  │  │  风险：缓存宕机可能丢失未落盘的数据        │        │
  │  │  适用：写多读少、可容忍少量丢失的场景       │        │
  │  └──────────────────────────────────────────┘        │
  └──────────────────────────────────────────────────────┘
```

## 十二、降级架构

### 12.1 本地锁回退

```java
// Redis 不可用时降级为本地锁
public class FallbackLockService {

    private final ConcurrentHashMap<String, ReentrantLock> localLocks
        = new ConcurrentHashMap<>();

    private final RedissonClient redissonClient;

    public Lock getLock(String lockKey) {
        try {
            // 优先使用 Redis 分布式锁
            RLock redisLock = redissonClient.getLock(lockKey);
            if (redisLock.tryLock(1, 30, TimeUnit.SECONDS)) {
                return redisLock;
            }
        } catch (Exception e) {
            log.warn("Redis锁获取失败，降级为本地锁: {}", e.getMessage());
        }

        // 降级为本地锁（仅保护单实例内的并发）
        ReentrantLock localLock = localLocks.computeIfAbsent(
            lockKey, k -> new ReentrantLock()
        );
        localLock.lock();
        return localLock;
    }
}
```

### 12.2 多组件降级链

```
  降级链架构
  ┌──────────────────────────────────────────────────────┐
  │                                                      │
  │  正常路径：                                           │
  │  Redis 分布式锁（高性能，微秒级）                      │
  │       │                                              │
  │       │ Redis 不可用？                                │
  │       ▼                                              │
  │  ZooKeeper 分布式锁（强一致，毫秒级）                  │
  │       │                                              │
  │       │ ZK 不可用？                                   │
  │       ▼                                              │
  │  数据库行锁（SELECT ... FOR UPDATE）                  │
  │       │                                              │
  │       │ DB 也不可用？                                  │
  │       ▼                                              │
  │  本地锁 + 返回"系统繁忙"                               │
  │                                                      │
  │  实际生产中，通常只需要 Redis → 本地锁 两级             │
  │  Redis 可用性通常 > 99.9%                             │
  └──────────────────────────────────────────────────────┘
```

## 十三、面试题精选

**Q1：Redis 分布式锁如何实现？SETNX + EXPIRE 有什么问题？**

使用 `SET key value NX EX seconds` 一条命令原子性地设置锁和过期时间。value 使用 UUID+threadId 保证唯一性。SETNX + EXPIRE 的问题是非原子操作：如果 SETNX 成功后、EXPIRE 执行前进程崩溃，锁永远不会过期，导致死锁。解锁时使用 Lua 脚本原子性地比较 value 是否匹配再 DEL，防止误删其他客户端的锁。

**Q2：Redisson 的 WatchDog 是怎么工作的？**

WatchDog 是 Redisson 的自动续期机制。当使用 `lock()` 不指定 leaseTime 时，加锁成功后会启动一个 Netty Timer 定时任务，每隔 internalLockLeaseTime/3（默认10秒）执行一次续期 Lua 脚本：检查 Hash 中线程标识是否存在，如果存在则 PEXPIRE 重置 TTL 为 30 秒。如果持有者进程崩溃，WatchDog 线程随之停止，锁在最后一次续期后 30 秒自动过期。

**Q3：RedLock 算法的原理和问题是什么？**

RedLock 使用 N 个独立 Redis 节点，客户端依次尝试加锁，如果多数节点（>= N/2+1）加锁成功且总耗时 < TTL，则认为加锁成功。问题包括：（1）依赖时钟同步，时钟跳变可能导致锁失效；（2）没有 fencing token，进程 GC 暂停后可能不知道自己已丢锁；（3）Martin Kleppmann 指出其在进程暂停场景下不安全。Redisson 已将 RedLock 标记为 Deprecated，推荐单实例锁 + 业务层兜底。

**Q4：如何保证缓存和数据库的一致性？**

根本原因是缓存和数据库是两个独立系统，无法原子更新。推荐方案：（1）Cache-Aside 模式：先更新 DB 后删除缓存，不一致窗口极小；（2）延迟双删：先删缓存、更新DB、延迟后再删缓存，解决并发读写问题；（3）Canal + Binlog（推荐）：监听 MySQL binlog 异步删除缓存，业务代码零侵入。不推荐"更新缓存"，因为并发写时可能写入不一致的值。

**Q5：Redis 事务为什么不支持回滚？Pipeline 和 Lua 脚本有什么区别？**

Redis 事务不支持回滚是因为：Redis 认为命令失败要么是语法错误（入队时可检测），要么是运行时错误（编程错误），不值得增加回滚机制的复杂性。Pipeline 是批量发送命令减少网络 RTT，但各命令独立执行，非原子；Lua 脚本在 Redis 中原子执行所有命令，性能更好且保证原子性。生产环境需要原子操作时优先使用 Lua 脚本。

**Q6：Redis 分布式锁在主从切换时会丢锁吗？怎么解决？**

会丢锁。因为 Redis 主从复制是异步的，Master 加锁成功后立即返回客户端，如果此时 Master 宕机且锁数据还未同步到 Slave，Slave 提升为新 Master 后没有锁数据，其他客户端可以再次获取同一把锁。解决方案：（1）接受风险 + 业务层幂等 + 状态检查 + DB唯一约束；（2）RedLock 多节点方案（但有争议）；（3）如果需要强一致性，使用 ZooKeeper。

**Q7：可重入锁的底层实现原理是什么？**

Redisson 的可重入锁使用 Redis Hash 结构：key 为锁名称，field 为 uuid:threadId，value 为重入计数。加锁 Lua 脚本中，如果锁不存在则 HSET count=1 并设置 TTL；如果 field 已存在（同一线程）则 HINCRBY count+1 并刷新 TTL；否则返回剩余 TTL（其他线程持有）。解锁时 HINCRBY count-1，count=0 时 DEL key。

---

> **延伸阅读**：[Redis 核心数据结构与底层实现](./redis-data-structures.md) | [Redis 持久化、集群架构与高可用方案](./redis-persistence-and-cluster.md)
