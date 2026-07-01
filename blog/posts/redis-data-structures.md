# Redis 核心数据结构与底层实现——从 SDS 到 SkipList

> 本文基于 Redis 7.x 源码，深入剖析 Redis 数据结构的底层实现原理。文章涵盖五大基本类型、高级数据类型、SDS、RESP 协议、渐进式 Rehash、跳表、ListPack 等核心知识点，适合中高级开发者与面试备考。

## 引言

Redis（Remote Dictionary Server）自 2009 年由 Salvatore Sanfilippo（antirez）创建以来，已经从一个简单的键值缓存工具发展为功能完备的内存数据结构服务器。在生产环境中，Redis 被广泛应用于缓存加速、消息队列、实时排行榜、分布式锁、会话管理等场景，是互联网技术栈中不可或缺的基础组件。

Redis 之所以能在单机达到 10w+ QPS 的极致性能，核心原因在于两个设计决策：**纯内存操作**与**精心设计的数据结构**。很多人只会用 `SET/GET` 把 Redis 当缓存，却不清楚 Redis 内部为每种数据类型都设计了至少两种底层编码，在不同数据规模下自动切换，以平衡时间与空间。这种"自适应编码"的设计思想是 Redis 区别于 Memcached 等简单缓存系统的核心优势——Memcached 只有 String 类型，而 Redis 提供了丰富的数据结构，并且每种结构都有精心设计的底层实现。

深入理解 Redis 的数据结构体系，对于开发者而言有三重价值：第一，能够根据业务场景选择最合适的数据类型，避免"一把梭"式地使用 String；第二，在排查性能问题（如大 Key 阻塞、内存膨胀）时能够快速定位根因；第三，在面试中能够展现对底层原理的深刻理解，而非停留在"会用"的层面。

本文将从上层命令到底层实现，逐层拆解 Redis 的数据结构体系，涵盖从 SDS 字符串到 SkipList 跳表的完整技术链路。

```
                Redis 数据类型与底层编码映射
  ┌──────────────────────────────────────────────────────────┐
  │  上层类型        底层编码（encoding）                      │
  │  ─────────      ─────────────────────                     │
  │  String    →    int / embstr / raw (SDS)                  │
  │  Hash      →    listpack / hashtable                      │
  │  List      →    listpack / quicklist (linked listpack)    │
  │  Set       →    intset / listpack / hashtable             │
  │  ZSet      →    listpack / skiplist + hashtable           │
  │  Stream    →    listpack + radix tree                     │
  └──────────────────────────────────────────────────────────┘
```

## 一、五大基本类型与核心命令

### 1.1 String（字符串）

String 是 Redis 最基础也是最万能的类型。它可以存储字符串、整数、浮点数，甚至是序列化的 JSON 对象。

```bash
# 基本读写
SET name "NeedHub"
GET name                    # "NeedHub"

# 数值操作（Redis 自动识别整数串）
SET counter 100
INCR counter                # 101
INCRBY counter 10           # 111
DECRBY counter 5            # 106

# 批量操作（减少网络 RTT）
MSET key1 "a" key2 "b" key3 "c"
MGET key1 key2 key3         # ["a", "b", "c"]

# 条件设置
SET token "abc" NX EX 3600  # 仅当 key 不存在时设置，TTL 3600秒
SET token "def" XX           # 仅当 key 存在时覆盖

# 字符串操作
APPEND name " Blog"         # 追加，返回新长度
STRLEN name                 # 返回字节长度
GETRANGE name 0 6           # 截取子串 "NeedHub"
```

**编码选择逻辑**：当 String 的值可以表示为 `long` 类型整数时，编码为 `int`（直接存值，零额外开销）；当字符串长度 <= 44 字节时，编码为 `embstr`（SDS 头与字符串内容连续分配，一次 `malloc`）；否则编码为 `raw`（SDS 头与内容分别分配）。

### 1.2 Hash（哈希）

Hash 是 field-value 的映射表，天然适合存储对象。

```bash
# 字段级操作
HSET user:1001 name "Alice" age 28 city "Shanghai"
HGET user:1001 name            # "Alice"
HMGET user:1001 name age       # ["Alice", "28"]

# 数值字段
HINCRBY user:1001 login_count 1

# 遍历
HKEYS user:1001                # 所有字段名
HVALS user:1001                # 所有字段值
HGETALL user:1001              # 所有字段和值（大 Hash 慎用，O(N)）

# 存在性检查
HEXISTS user:1001 email        # 0 或 1
HLEN user:1001                 # 字段数量
```

**为什么用 Hash 而不是 JSON String？** 用 String 存 JSON 每次读写都是全量序列化/反序列化；Hash 可以只操作单个字段，且 Redis 内部对 Hash 有专门的压缩编码优化。

### 1.3 List（列表）

List 是有序的双端链表，支持头尾推入弹出，常用于消息队列和时间线。

```bash
# 推入元素
LPUSH timeline "post_001" "post_002"
RPUSH timeline "post_003"

# 弹出元素
LPOP timeline                  # 从左弹出
RPOP timeline                  # 从右弹出

# 阻塞弹出（消息队列核心命令）
BLPOP task_queue 30            # 阻塞最多30秒等待元素
BRPOP task_queue 0             # 无限阻塞

# 范围查询
LRANGE timeline 0 -1           # 获取全部元素
LRANGE timeline 0 9            # 前10条

# 裁剪（保留最新N条）
LTRIM timeline 0 99            # 只保留前100条
```

### 1.4 Set（集合）

Set 是无序、不重复的字符串集合，底层基于哈希表实现（小数据量时用 intset 或 listpack）。

```bash
# 添加/删除
SADD tags:article:1 "Redis" "Java" "Backend"
SREM tags:article:1 "Java"

# 集合运算
SINTER tags:article:1 tags:article:2    # 交集
SUNION tags:article:1 tags:article:2    # 并集
SDIFF  tags:article:1 tags:article:2    # 差集

# 成员检查
SISMEMBER tags:article:1 "Redis"        # 1
SMEMBERS tags:article:1                 # 所有成员
SCARD tags:article:1                    # 成员数量

# 随机弹出（抽奖场景）
SRANDMEMBER lottery 3                   # 随机取3个（不弹出）
SPOP lottery 1                          # 随机弹出1个
```

### 1.5 ZSet（有序集合）

ZSet 在 Set 基础上为每个元素关联一个 score（double 类型），按 score 排序。

```bash
# 添加元素
ZADD leaderboard 1500 "Alice" 2300 "Bob" 1800 "Charlie"

# 排名查询（0-indexed，从小到大）
ZRANK leaderboard "Bob"            # 2
ZREVRANK leaderboard "Bob"         # 0（从大到小排名，Bob第一）

# 范围查询
ZRANGE leaderboard 0 -1 WITHSCORES           # 全部，按分数升序
ZREVRANGE leaderboard 0 9 WITHSCORES         # Top 10，按分数降序
ZRANGEBYSCORE leaderboard 1000 2000          # 分数区间查询

# 分数操作
ZINCRBY leaderboard 500 "Alice"              # Alice 分数 +500
ZSCORE leaderboard "Alice"                   # 2000

# 删除
ZREM leaderboard "Charlie"
ZREMRANGEBYRANK leaderboard 0 0              # 删除排名最低的
```

## 二、高级数据类型

### 2.1 Bitmap（位图）

Bitmap 本质是 String 类型的位操作，通过偏移量直接操作二进制位，空间效率极高。

```bash
# 签到系统：用户 1001 在 2024 年 1 月 15 日签到
SETBIT sign:1001:202401 15 1

# 检查某天是否签到
GETBIT sign:1001:202401 15       # 1

# 统计签到天数
BITCOUNT sign:1001:202401

# 多用户签到交集（连续签到分析）
BITOP AND result sign:1001:202401 sign:1002:202401
```

一个用户一年的签到数据仅需 365 bit ≈ 46 字节，百万用户一年签到数据约 44 MB。

### 2.2 HyperLogLog

基于概率算法的基数统计，误差约 0.81%，内存固定 12 KB。

```bash
PFADD uv:20240101 "user_001" "user_002" "user_003"
PFCOUNT uv:20240101              # 估算UV数
PFMERGE uv:weekly uv:20240101 uv:20240102 uv:20240103
```

### 2.3 Geospatial（地理位置）

基于 GEOHASH 编码将二维经纬度映射为一维整数，存储在 ZSet 中。

```bash
GEOADD shops 121.4737 31.2304 "Shanghai_Store"
GEOADD shops 116.4074 39.9042 "Beijing_Store"

GEODIST shops Shanghai_Store Beijing_Store km
GEORADIUS shops 121.4737 31.2304 100 km WITHDIST COUNT 10
```

### 2.4 Stream（消息流）

Redis 5.0 引入的 Stream 是真正的消息队列，支持消费者组和消息确认。

```bash
# 生产消息
XADD orders * user_id 1001 amount 99.9

# 消费消息
XREAD COUNT 10 STREAMS orders 0

# 消费者组
XGROUP CREATE orders order_group 0
XREADGROUP GROUP order_group consumer1 COUNT 1 STREAMS orders >

# 确认消息
XACK orders order_group 1526919030474-0
```

## 三、redisObject 对象模型

在深入 SDS 之前，需要先理解 Redis 的对象模型。Redis 中所有数据（键和值）都以 `redisObject` 结构体封装。这个结构体是连接上层命令与底层数据结构的桥梁。

```c
typedef struct redisObject {
    unsigned type:4;      // 对象类型（String/List/Hash/Set/ZSet）
    unsigned encoding:4;  // 底层编码（int/raw/hashtable/skiplist等）
    unsigned lru:24;      // LRU 时钟（用于内存淘汰）
    int refcount;         // 引用计数（用于内存管理）
    void *ptr;            // 指向底层数据结构的指针
} robj;
```

`type` 和 `encoding` 的组合决定了 Redis 如何操作这个对象。例如，同样是 String 类型，当 encoding 为 `int` 时，`ptr` 直接存储整数值（零开销）；当 encoding 为 `raw` 时，`ptr` 指向一个 SDS 结构。这种设计使得 Redis 可以在运行时根据数据特征动态选择最优的底层实现，对上层命令完全透明。

```
  redisObject 与底层数据结构的关系
  ┌──────────────────────────────────────────────────────┐
  │  redisObject                                         │
  │  ┌────────┬──────────┬───────┬──────────┬──────────┐│
  │  │ type   │ encoding │  lru  │ refcount │   ptr    ││
  │  │String  │  raw     │       │    1     │    ↓     ││
  │  └────────┴──────────┴───────┴──────────┴────┬─────┘│
  │                                              │      │
  │                                              ▼      │
  │                                    ┌──────────────┐ │
  │                                    │   SDS 结构    │ │
  │                                    │ len=5         │ │
  │                                    │ alloc=10      │ │
  │                                    │ buf="Hello"   │ │
  │                                    └──────────────┘ │
  └──────────────────────────────────────────────────────┘

  通过 OBJECT ENCODING key 命令可以查看任意 key 的底层编码：
  SET name "NeedHub"
  OBJECT ENCODING name    # "embstr"（短字符串优化）

  SET counter 100
  OBJECT ENCODING counter # "int"（整数优化）

  SET big "这是一个超过44字节的较长字符串..."
  OBJECT ENCODING big     # "raw"（SDS 原始编码）
```

引用计数 `refcount` 是 Redis 内存管理的核心机制。当计数降为 0 时，对象及其指向的底层数据结构会被释放。Redis 还使用引用计数实现了共享对象池——常用的 0~9999 整数对象在启动时预创建并共享，避免重复分配。

## 四、SDS（Simple Dynamic Strings）底层实现

### 4.1 SDS 结构体

Redis 没有使用 C 语言原生的字符串（以 `\0` 结尾的字符数组），而是自己实现了 SDS。核心原因在于 C 字符串的三大缺陷：获取长度 O(N)、不支持二进制安全、追加操作频繁 realloc。

Redis 7.x 中 SDS 定义了三种头部结构，根据字符串长度选择：

```c
// sdshdr8：长度 < 2^8 (256字节)
struct __attribute__ ((__packed__)) sdshdr8 {
    uint8_t len;         // 已使用长度（不含 \0）
    uint8_t alloc;       // 分配的总长度（不含 \0 和头部）
    unsigned char flags; // 类型标记，低3位标识 header 类型
    char buf[];          // 柔性数组，实际字符串内容
};

// sdshdr16：长度 < 2^16
struct __attribute__ ((__packed__)) sdshdr16 {
    uint16_t len;
    uint16_t alloc;
    unsigned char flags;
    char buf[];
};

// sdshdr32 / sdshdr64 类似，字段类型更大
```

**关键设计**：
- `__packed__` 属性取消结构体对齐，节省内存
- `len` 字段使得获取字符串长度变为 O(1)
- `alloc` 字段记录分配空间，追加操作时可直接判断是否需要扩容
- `buf[]` 柔性数组，内容与头部连续分配
- 末尾自动追加 `\0`，兼容部分 C 字符串函数

```
  SDS 内存布局（以 sdshdr8 为例）
  ┌──────┬──────┬──────┬───────────────────┬─────┐
  │ len  │alloc │flags │     buf[]         │ \0  │
  │  5   │  10  │  0   │ H e l l o         │     │
  └──────┴──────┴──────┴───────────────────┴─────┘
  ^                              ^
  头部(3字节)              flags 低3位=000 表示 sdshdr8

  Redis 对象头（redisObject）的 ptr 指向 buf[] 起始位置
  所以 sds len 操作：
  1. ptr 回退 1 字节拿到 flags
  2. 根据 flags 判断头部类型
  3. 回退对应头部大小拿到 len 字段
```

### 3.2 空间预分配策略

SDS 在追加内容时采用预分配策略，大幅减少 `realloc` 调用次数：

```c
// sdsMakeRoomFor 核心逻辑（简化）
if (newlen < SDS_MAX_PREALLOC)    // SDS_MAX_PREALLOC = 1MB
    newlen *= 2;                  // 小于1MB时，分配双倍空间
else
    newlen += SDS_MAX_PREALLOC;   // 大于1MB时，每次多分配1MB
```

这意味着一个从空字符串逐字节追加到长度 N 的字符串，C 原生需要 N 次 realloc，而 SDS 最多需要 log(N) 次。这是经典的**空间换时间**策略。

### 3.3 惰性空间释放

当字符串缩短时，SDS 不会立即释放多余空间，而是仅更新 `len` 字段。如果后续再次追加，可以直接复用已有空间。

```c
void sdsclear(sds s) {
    sdssetlen(s, 0);   // 仅将 len 置0
    s[0] = '\0';        // 不释放内存
}
```

如需释放多余空间，可显式调用 `sdsRemoveFreeSpace()`。

### 3.4 二进制安全

由于 SDS 使用 `len` 字段而非 `\0` 标识字符串结束，因此可以安全存储任意二进制数据，包括 `\0` 字节本身。这使得 Redis String 可以存储图片、序列化对象等二进制内容。

## 四、RESP 协议

### 4.1 协议格式

RESP（REdis Serialization Protocol）是 Redis 客户端与服务端的通信协议，设计目标是简单、高效、可读。

```
  RESP 协议数据类型
  ┌─────────────────────────────────────────────────┐
  │ 前缀字节    类型          示例                    │
  │ ────────    ────          ────                    │
  │ +           简单字符串    +OK\r\n                 │
  │ -           错误          -ERR unknown\r\n        │
  │ :           整数          :1000\r\n               │
  │ $           批量字符串    $5\r\nhello\r\n         │
  │ *           数组          *2\r\n$3\r\nfoo\r\n...  │
  └─────────────────────────────────────────────────┘
```

**以 `SET name "NeedHub"` 为例的完整通信过程**：

```
客户端发送：
*3\r\n$3\r\nSET\r\n$4\r\nname\r\n$7\r\nNeedHub\r\n

拆解：
*3          → 数组，包含3个元素
\r\n        → 分隔符
$3          → 第1个元素是长度3的字符串
\r\n
SET         → 字符串内容
\r\n
$4          → 第2个元素是长度4的字符串
\r\n
name
\r\n
$7          → 第3个元素是长度7的字符串
\r\n
NeedHub
\r\n

服务端响应：
+OK\r\n     → 简单字符串 "OK"
```

### 4.2 RESP3 协议（Redis 6.0+）

RESP3 新增了更多数据类型标识，支持 Map、Set、Boolean、Null 等原生类型，减少了客户端的类型推断开销。

## 五、Hash 渐进式 Rehash

### 5.1 哈希表结构

Redis 的字典（Dict）使用两个哈希表实现渐进式 Rehash：

```c
typedef struct dict {
    dictType *type;          // 类型特定函数
    void *privdata;
    dictht ht[2];            // 两个哈希表，ht[0]当前使用，ht[1]用于rehash
    long rehashidx;          // rehash 进度，-1 表示未在进行 rehash
    // ...
} dict;

typedef struct dictht {
    dictEntry **table;       // 哈希表数组（桶数组）
    unsigned long size;      // 桶数组大小
    unsigned long sizemask;  // size - 1，用于快速取模
    unsigned long used;      // 已使用桶数
} dictht;

typedef struct dictEntry {
    void *key;
    union {
        void *val;
        uint64_t u64;
        int64_t s64;
        double d;
    } v;
    struct dictEntry *next;  // 链地址法解决冲突
} dictEntry;
```

### 5.2 渐进式 Rehash 过程

当哈希表负载因子过高（或过低）时触发 Rehash。Redis 不会一次性迁移所有数据（那会阻塞主线程），而是在每次 CRUD 操作中迁移一部分：

```
  渐进式 Rehash 过程示意

  rehash 开始时：
  ht[0]: [bucket0, bucket1, ..., bucketN]    ← 旧表，数据在这
  ht[1]: [bucket0, bucket1, ..., bucket2N+1] ← 新表，空的，大小>=旧表2倍
  rehashidx = 0

  每次 ADD/DELETE/LOOKUP 操作时：
  1. 正常在 ht[0] 和 ht[1] 中查找/操作
     - 查找：先查 ht[0]，再查 ht[1]
     - 新增：只往 ht[1] 中加（保证 ht[0] 只减不增）
  2. 将 ht[0].table[rehashidx] 的所有元素迁移到 ht[1]
  3. rehashidx++
  4. 当 ht[0].used == 0 时，释放 ht[0]，将 ht[1] 赋值给 ht[0]

  rehash 进行中（rehashidx = 2）：
  ht[0]: [已迁移, 已迁移, bucket2, bucket3, ...]
  ht[1]: [...迁移过来的元素...]
              ↑
         rehashidx 指向下一个待迁移的桶
```

### 5.3 触发条件

```c
// 扩容触发（简化逻辑）
if (ht[0].used >= ht[0].size &&
    dict_can_resize == 1)  // 非 BGSAVE 子进程期间
{
    // 扩容到 >= used * 2 的最小 2^n
    dictExpand(ht[0].used * 2);
}

// 缩容触发
if (ht[0].size > DICT_HT_INITIAL_SIZE &&
    ht[0].used * 100 / ht[0].size < 10)  // 负载率 < 10%
{
    dictExpand(ht[0].used * 2);  // 缩容到刚好够用
}
```

注意：在 BGSAVE 期间 Redis 禁止扩容（`dict_can_resize = 0`），因为 fork 子进程后写时复制（COW）机制下，扩容导致的内存页修改会翻倍实际内存消耗。

### 5.4 内存代价分析

Rehash 期间新旧两张表同时存在，内存峰值可达平时的 2 倍以上。对于大 Key 的 Hash（如 100 万字段），Rehash 期间的内存开销不可忽视。生产环境中应监控 `used_memory_peak` 指标。

## 六、ZSet 双架构：Dict + SkipList

### 6.1 为什么需要两种结构

ZSet 需要同时支持两种操作模式：
- **按成员查分数**：`ZSCORE key member` → O(1)，需要哈希表
- **按分数排序遍历**：`ZRANGEBYSCORE` → O(logN + M)，需要有序结构

Redis 同时维护一个 Dict 和一个 SkipList：

```
  ZSet 双架构
  ┌─────────────────────────────────────────────┐
  │                                             │
  │   Dict (哈希表)          SkipList (跳表)      │
  │   member → score         score → member      │
  │                                             │
  │   ┌──────────┐          ┌─→ header ──────→ tail  │
  │   │ "Alice"→1500│        │                       │
  │   │ "Bob"→2300  │        │  level3: Bob(2300)    │
  │   │ "Charlie"→1800│      │  level2: Bob→Charlie  │
  │   └──────────┘        │  level1: Alice→Bob→Charlie│
  │                         │  level0: Alice→Bob→Charlie│
  │   O(1) 查分数          └─ O(logN) 有序遍历       │
  └─────────────────────────────────────────────┘
```

### 6.2 SkipList 跳表详解

跳表是在有序链表基础上增加多级索引的平衡数据结构。

```
  跳表结构示意（插入 score=15, 25, 35, 45）

  Level 3:  [head] ──────────────────→ [25] ──────────→ [NULL]
  Level 2:  [head] ────────→ [15] ──→ [25] ──→ [35] ──→ [NULL]
  Level 1:  [head] ──→ [15] ──→ [25] ──→ [35] ──→ [45] ──→ [NULL]
  Level 0:  [head] ──→ [15] ──→ [25] ──→ [35] ──→ [45] ──→ [NULL]
             (base level，包含所有元素)

  每个节点的层数是随机生成的（概率 p=0.25）：
  randomLevel():
      level = 1
      while random() < 0.25 and level < MAX_LEVEL:
          level++
      return level

  查询 score=35 的路径：
  head → L3 → 25 → L2 → 35（命中）
  比较次数：3次，远少于链表的 4次
```

跳表相比平衡二叉树的优势：
1. **实现简单**：插入/删除只需修改指针，无需旋转
2. **范围查询高效**：Level 0 就是有序链表，找到起点后顺序遍历即可
3. **并发友好**：修改局部化，不影响全局结构

### 6.3 SkipList 节点结构

```c
typedef struct zskiplistNode {
    sds ele;                    // 成员（SDS 字符串）
    double score;               // 分数
    struct zskiplistNode *backward; // 后退指针（用于反向遍历）
    struct zskiplistLevel {
        struct zskiplistNode *forward; // 前进指针
        unsigned long span;            // 跨越的节点数（用于计算 rank）
    } level[];                  // 柔性数组，层级数随机
} zskiplistNode;
```

`span` 字段用于高效计算排名：从头节点出发到目标节点路径上所有 span 之和减 1 即为 rank。

## 七、ZipList 到 ListPack 的演进

### 7.1 ZipList 的级联更新问题

ZipList 是 Redis 早期的紧凑编码，所有元素连续存储在一段内存中。每个节点头部包含 `prevlen`（前一个节点的长度），用于反向遍历。

```
  ZipList 结构
  ┌──────────┬──────────┬────────────────────────────┬─────┐
  │ zlbytes  │ zltail   │  entry1 | entry2 | ...    │ zlend│
  │ (4B)     │ (4B)     │  每个 entry 包含：          │(0xFF)│
  │          │          │  prevlen + encoding + data │     │
  └──────────┴──────────┴────────────────────────────┴─────┘

  级联更新（Cascade Update）问题：
  ┌──────────────────────────────────────────────────┐
  │ entry1(100B) → entry2 → entry3 → ...            │
  │                                                  │
  │ 当 entry1 增长到 300B 时：                        │
  │ 1. entry2 的 prevlen 需要从 1 字节扩展到 5 字节   │
  │ 2. entry2 整体后移 4 字节                         │
  │ 3. entry3 的 prevlen 也需要更新（如果也跨越阈值）  │
  │ 4. 级联传播，最坏情况 O(N^2)                      │
  └──────────────────────────────────────────────────┘
```

级联更新发生在节点长度跨越 254 字节阈值时（prevlen 从 1 字节编码变为 5 字节编码），插入/删除操作的最坏时间复杂度退化为 O(N^2)。

### 7.2 ListPack 的改进

Redis 5.0 引入 ListPack 替代 ZipList，核心改进是**移除 prevlen，改用 backlen**：

```
  ListPack 节点结构
  ┌────────────┬────────────┬─────────┐
  │  element   │  encoding  │ backlen │
  │  (数据)     │  (编码头)   │(向后长度)│
  └────────────┴────────────┴─────────┘

  backlen 记录的是「当前节点 encoding + element」的长度
  反向遍历时：读取当前节点尾部的 backlen → 回退 backlen 字节 → 到达前一个节点
```

**关键优势**：当某个节点长度变化时，只需要更新紧邻的下一个节点的 backlen，不会触发级联更新。时间复杂度从 O(N^2) 降为 O(1)。

## 八、编码转换阈值

Redis 根据数据量和元素大小自动选择底层编码。以下是核心阈值（Redis 7.x）：

```
  ┌──────────────────────────────────────────────────────────┐
  │ 类型    条件                           编码               │
  │ ────    ────                           ────               │
  │ String  整数值                         int                │
  │         长度 <= 44 字节                embstr             │
  │         长度 > 44 字节                 raw (SDS)          │
  │                                                          │
  │ Hash    元素 < 128 且每个 < 64 字节    listpack           │
  │         超出上述任一条件               hashtable          │
  │                                                          │
  │ List    元素 < 128 且每个 < 64 字节    listpack           │
  │         超出                           quicklist          │
  │                                                          │
  │ Set     全是整数且 < 512 个            intset             │
  │         元素 < 128 且每个 < 64 字节    listpack           │
  │         超出                           hashtable          │
  │                                                          │
  │ ZSet    元素 < 128 且每个 < 64 字节    listpack           │
  │         超出                           skiplist+hashtable │
  └──────────────────────────────────────────────────────────┘

  阈值可通过配置调整：
  hash-max-listpack-entries 128
  hash-max-listpack-value 64
  zset-max-listpack-entries 128
  zset-max-listpack-value 64
```

编码转换是**单向**的：小数据量使用紧凑编码（listpack），数据量增长后切换为大编码（hashtable/skiplist），但不会自动回退。这种单向设计的考量在于：回退需要重新检查所有元素是否满足紧凑编码条件，计算代价高；而且在生产环境中，数据量通常是增长趋势，回退后很快又需要再次切换，得不偿失。

### 8.1 编码转换的性能影响

编码转换是一个需要特别关注的运维事件。当 Hash 从 listpack 转换为 hashtable 时，Redis 需要一次性将所有元素从紧凑的连续内存结构迁移到哈希表中。对于包含数千个字段的大 Hash，这个转换过程可能阻塞主线程数毫秒，在高并发场景下可能导致短暂的请求延迟尖峰。

因此，在生产环境中建议：如果预知某个 Hash 会存储大量数据，可以在创建时就填充足够多的字段触发编码转换，避免在业务高峰期发生转换。同理，对于 ZSet 也应采用相同策略。

### 8.2 ListPack 的内部存储细节

ListPack 作为 Hash、List、Set、ZSet 的紧凑编码，其内存布局值得深入理解。ListPack 将所有元素连续存储在一块内存中，没有指针开销，对 CPU 缓存非常友好。在元素数量较少时（<128个），ListPack 的顺序遍历性能甚至优于哈希表的随机访问，因为连续内存的缓存命中率极高。

ListPack 的每个元素由三部分组成：编码头（标识数据类型和长度）、数据内容、backlen（用于反向遍历的向后长度）。这种设计使得正向遍历和反向遍历都能高效进行，同时避免了 ZipList 的级联更新问题。

## 九、五大类型业务落地

### 9.1 String：缓存 / 分布式会话 / 限流

```java
// Spring Boot + Lettuce 示例：分布式限流
@Service
public class RateLimiterService {

    @Autowired
    private StringRedisTemplate redisTemplate;

    /**
     * 固定窗口限流器
     * @param key    限流键（如 rate:user:1001）
     * @param limit  窗口内最大请求数
     * @param window 窗口时长（秒）
     * @return true=允许, false=被限流
     */
    public boolean isAllowed(String key, int limit, int window) {
        Long current = redisTemplate.opsForValue().increment(key);
        if (current != null && current == 1) {
            // 首次访问，设置过期时间
            redisTemplate.expire(key, window, TimeUnit.SECONDS);
        }
        return current != null && current <= limit;
    }
}

// 分布式会话（Spring Session + Redis）
@Configuration
@EnableRedisHttpSession(maxInactiveIntervalInSeconds = 1800)
public class SessionConfig {
    @Bean
    public RedisConnectionFactory connectionFactory() {
        return new LettuceConnectionFactory("redis-host", 6379);
    }
}
```

### 9.2 Hash：购物车

```java
// 购物车服务
public class CartService {
    private static final String CART_PREFIX = "cart:";

    @Autowired
    private StringRedisTemplate redisTemplate;

    public void addItem(Long userId, String skuId, int quantity) {
        String cartKey = CART_PREFIX + userId;
        redisTemplate.opsForHash().increment(cartKey, skuId, quantity);
        // 设置过期时间，防止僵尸购物车占用内存
        redisTemplate.expire(cartKey, 30, TimeUnit.DAYS);
    }

    public Map<String, Integer> getCart(Long userId) {
        Map<Object, Object> raw = redisTemplate.opsForHash()
            .entries(CART_PREFIX + userId);
        Map<String, Integer> cart = new HashMap<>();
        raw.forEach((k, v) -> cart.put(k.toString(), Integer.parseInt(v.toString())));
        return cart;
    }

    public void removeItem(Long userId, String skuId) {
        redisTemplate.opsForHash().delete(CART_PREFIX + userId, skuId);
    }
}
```

### 9.3 List：消息队列 / 时间线

```bash
# 简单消息队列（生产者-消费者）
# 生产者
LPUSH task_queue "{\"task\":\"send_email\",\"to\":\"user@example.com\"}"

# 消费者（阻塞式，类似 Kafka consumer）
BRPOP task_queue 0    # 阻塞等待，有消息立即返回

# 最新动态时间线（只保留最新 200 条）
LPUSH timeline:user:1001 "post_content..."
LTRIM timeline:user:1001 0 199
```

### 9.4 Set：标签系统 / 抽奖 / 共同好友

```bash
# 文章标签
SADD article:1001:tags "Redis" "Java" "分布式"

# 共同好友（两个用户的关注集合取交集）
SINTER user:1001:following user:1002:following

# 抽奖系统
SADD lottery:2024 "user_001" "user_002" ... "user_9999"
# 抽取3名中奖者
SPOP lottery:2024 3
```

### 9.5 ZSet：排行榜 / 延迟队列

```java
// 游戏排行榜
public class LeaderboardService {

    @Autowired
    private StringRedisTemplate redisTemplate;

    private static final String BOARD_KEY = "leaderboard:global";

    public void submitScore(String player, double score) {
        redisTemplate.opsForZSet().add(BOARD_KEY, player, score);
    }

    public List<String> getTop10() {
        Set<String> top = redisTemplate.opsForZSet()
            .reverseRange(BOARD_KEY, 0, 9);
        return top != null ? new ArrayList<>(top) : Collections.emptyList();
    }

    public Long getRank(String player) {
        // reverseRank: 0-indexed，分数从高到低
        return redisTemplate.opsForZSet().reverseRank(BOARD_KEY, player);
    }
}

// 延迟队列（score 存储执行时间戳）
public class DelayQueue {
    private static final String QUEUE_KEY = "delay_queue";

    public void schedule(String taskId, long executeAtMillis) {
        redisTemplate.opsForZSet().add(QUEUE_KEY, taskId, executeAtMillis);
    }

    public List<String> pollReady() {
        long now = System.currentTimeMillis();
        // 取出所有到期任务
        Set<String> ready = redisTemplate.opsForZSet()
            .rangeByScore(QUEUE_KEY, 0, now);
        if (ready != null && !ready.isEmpty()) {
            // 原子移除已处理的任务
            redisTemplate.opsForZSet()
                .removeRangeByScore(QUEUE_KEY, 0, now);
            return new ArrayList<>(ready);
        }
        return Collections.emptyList();
    }
}
```

## 十、架构选型指南

在实际项目中，数据类型的选择往往直接影响系统的性能和可维护性。以下是基于大量生产实践总结的选型决策框架。

选型的核心原则是：**用最自然的数据结构表达业务语义**。不要为了"省事"把所有数据都序列化为 String 存储——这不仅浪费了 Redis 精心设计的底层编码优化，还会导致无法利用原子操作（如 INCR、HINCRBY）和集合运算（如 SINTER、SUNION），最终不得不在应用层用更复杂的代码实现本可以由 Redis 原生完成的功能。

常见的选型误区包括：用 String 存储 JSON 对象（应该用 Hash，支持字段级读写）；用 String + 分隔符存储列表（应该用 List，支持 LPUSH/RPOP）；用 String 拼接存储集合（应该用 Set，支持 SISMEMBER O(1) 检查）。这些误区的根因是对 Redis 数据类型缺乏了解，导致"万物皆 String"的反模式。

```
  数据类型选型决策树

  需要存储什么？
  │
  ├── 简单键值对 → String
  │   ├── 缓存热点数据（用户信息、配置）
  │   ├── 分布式锁（SET NX EX）
  │   ├── 计数器（INCR/DECR）
  │   └── 分布式会话（Session ID → Session Data）
  │
  ├── 对象属性 → Hash
  │   ├── 用户资料、商品信息
  │   └── 购物车（userId → {skuId: quantity}）
  │
  ├── 有序列表 → List
  │   ├── 消息队列（LPUSH + BRPOP）
  │   └── 最新动态（LPUSH + LTRIM）
  │
  ├── 去重集合 → Set
  │   ├── 标签系统
  │   ├── 抽奖
  │   └── 共同好友/兴趣交集
  │
  ├── 排序集合 → ZSet
  │   ├── 排行榜
  │   ├── 延迟队列
  │   └── 带权重的任务调度
  │
  └── 特殊场景
      ├── 签到统计 → Bitmap
      ├── UV 统计 → HyperLogLog
      ├── 附近搜索 → Geo
      └── 消息流 → Stream
```

## 十一、面试题精选

**Q1：Redis String 底层用的是什么数据结构？为什么不直接用 C 字符串？**

Redis String 底层使用 SDS（Simple Dynamic Strings）。不用 C 字符串的原因有三：（1）C 字符串获取长度需要遍历，O(N)，SDS 通过 len 字段实现 O(1)；（2）C 字符串追加操作需要频繁 realloc，SDS 通过预分配策略减少到 log(N) 次；（3）C 字符串以 `\0` 结尾，无法存储二进制数据，SDS 通过 len 字段实现二进制安全。

**Q2：Hash 的渐进式 Rehash 是怎么工作的？为什么不能一次性迁移？**

渐进式 Rehash 同时维护新旧两张哈希表 ht[0] 和 ht[1]。在每次执行 ADD/DELETE/LOOKUP 等命令时，除了正常操作外，还会将 ht[0] 中 rehashidx 指向的桶的所有元素迁移到 ht[1]，然后 rehashidx++。当 ht[0] 清空后，释放旧表，ht[1] 变为新的 ht[0]。不能一次性迁移是因为 Redis 是单线程模型（核心操作），大量数据一次性迁移会阻塞主线程，导致其他请求超时。

**Q3：ZSet 为什么同时使用哈希表和跳表？**

哈希表用于 O(1) 查询成员分数（ZSCORE），跳表用于 O(logN) 的范围排序查询（ZRANGEBYSCORE）。单独使用哈希表无法高效排序，单独使用跳表无法 O(1) 查分数。两者互补，是典型的**空间换时间**设计。

**Q4：ZipList 和 ListPack 的区别是什么？**

ZipList 每个节点存储 prevlen（前一个节点的长度），当节点长度跨越 254 字节阈值时，prevlen 编码从 1 字节变为 5 字节，导致后续节点位置变化，触发级联更新，最坏 O(N^2)。ListPack 移除 prevlen，改用 backlen（当前节点自身长度），存储在节点末尾。节点长度变化只影响紧邻的下一个节点，无级联更新问题。

**Q5：Redis 在什么条件下会将 ZSet 从 listpack 编码切换为 skiplist+hashtable？**

当 ZSet 满足以下任一条件时切换：（1）元素个数 >= 128（zset-max-listpack-entries）；（2）任一元素长度 >= 64 字节（zset-max-listpack-value）。切换是单向的，不会自动回退。

**Q6：SDS 的 embstr 和 raw 编码有什么区别？**

embstr 在创建时将 redisObject 头和 SDS 结构、字符串内容在一次 malloc 中连续分配，内存局部性好，缓存命中率高，适用于短字符串（<=44 字节）。raw 编码中 redisObject 和 SDS 分别分配，适用于长字符串。embstr 是只读的（任何修改都会转为 raw），所以 APPEND 等操作后编码会变为 raw。

**Q7：Redis 的 QuickList 是什么？为什么 List 不直接用链表？**

QuickList 是 Redis 3.2 引入的 List 底层实现，它是双向链表和 ListPack 的混合体。链表的每个节点实际上是一个 ListPack（包含多个元素）。纯链表的问题是：每个节点只有一个元素，指针开销大（prev + next 共 16 字节），内存利用率低；纯 ListPack 的问题是：插入/删除需要移动大量元素，O(N) 复杂度。QuickList 结合了两者的优点——链表提供 O(1) 的头尾操作和灵活的插入位置，ListPack 提供紧凑的内存布局和缓存友好性。通过 `list-max-ziplist-size` 可以控制每个 ListPack 节点的大小。

**Q8：IntSet 是什么？在什么场景下会用到？**

IntSet 是 Set 类型在特定条件下的底层编码——当集合中所有元素都是整数且元素数量不超过 512 个时，Redis 使用 IntSet 而非哈希表。IntSet 是一段连续内存，按升序存储整数，支持二分查找（O(logN)）。它的内存效率远高于哈希表，因为没有任何指针开销。当集合中出现第一个非整数元素，或者元素数量超过 512 时，IntSet 会一次性转换为哈希表。这个转换过程是 O(N) 的，对于大集合可能阻塞主线程。

---

> **延伸阅读**：[Redis 持久化、集群架构与高可用方案](./redis-persistence-and-cluster.md) | [Redis 分布式锁与缓存一致性](./redis-distributed-lock-and-cache.md)
