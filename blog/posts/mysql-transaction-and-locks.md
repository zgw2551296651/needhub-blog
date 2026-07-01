# MySQL 事务与锁机制——ACID、MVCC 与死锁防治

> 事务是关系型数据库的核心特性，而锁是实现并发控制的基础设施。本文从 ACID 的实现机制出发，深入 MVCC 版本链与 ReadView 的工作原理，详解 InnoDB 的行级锁类型，最终给出死锁防治与幻读治理的完整方案。

---

## 一、事务的基本概念

事务是一组逻辑上不可分割的操作序列，要么全部执行成功，要么全部回滚。

```sql
-- 经典转账场景
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE user_id = 1;
UPDATE accounts SET balance = balance + 100 WHERE user_id = 2;
COMMIT;

-- 如果第二条语句失败
ROLLBACK; -- 两条 UPDATE 全部撤销
```

---

## 二、ACID 特性的实现机制

| ACID 特性 | 含义 | InnoDB 实现方式 |
|-----------|------|----------------|
| **A**tomicity（原子性） | 事务中的操作不可分割 | Undo Log |
| **C**onsistency（一致性） | 数据从一个合法状态到另一个合法状态 | A+I+D 综合保障 |
| **I**solation（隔离性） | 并发事务之间互不干扰 | MVCC + 锁机制 |
| **D**urability（持久性） | 事务提交后数据不丢失 | Redo Log |

### 2.1 原子性：Undo Log

Undo Log 记录事务修改前的数据版本，用于回滚：

```
Undo Log 记录类型：
┌─────────────────────────────────────────────────────┐
│ INSERT 操作 → 记录插入行的主键（回滚时按主键删除）  │
│ UPDATE 操作 → 记录修改前的整行旧值（回滚时恢复）     │
│ DELETE 操作 → 记录被删除的整行（回滚时重新插入）     │
└─────────────────────────────────────────────────────┘

事务执行流程：
BEGIN;
  UPDATE users SET name='Alice' WHERE id=1;
  → 写 Undo Log: {id=1, name='Bob'}（旧值）
  → 修改 Buffer Pool 中的数据
  → 写 Redo Log（prepare 状态）

COMMIT;
  → Redo Log 状态改为 commit
  → Undo Log 标记为可清理（purge 线程异步清理）

ROLLBACK;
  → 读取 Undo Log，将 name 恢复为 'Bob'
```

### 2.2 持久性：Redo Log

Redo Log 是物理日志，记录"在哪个页做了什么修改"：

```
Redo Log 的循环写入机制：

  文件大小（如 innodb_log_file_size=1G, innodb_log_files_in_group=2）

  ┌─────────────────────────────┐
  │ ib_logfile0 (1G)            │
  │ [已提交][已提交][...][可覆写]│
  └─────────────────────────────┘
  ┌─────────────────────────────┐
  │ ib_logfile1 (1G)            │
  │ [可覆写][可覆写][...][写入中]│
  └─────────────────────────────┘

  write_pos ───→ 当前写入位置（循环前进）
  checkpoint ──→ 已刷盘位置（脏页 flush 后前移）

  write_pos 追上 checkpoint 时 → 触发脏页刷新（阻塞）

Redo Log 写入时机：
1. 事务执行中：写入 Redo Log Buffer（内存）
2. 事务提交时：Redo Log Buffer → OS Page Cache → fsync 到磁盘
3. 后台线程：定期将脏页从 Buffer Pool 刷入磁盘数据文件
```

### 2.3 隔离性：MVCC + 锁

隔离性是事务中最复杂的部分，由 MVCC（多版本并发控制）和锁机制协同实现。后文将详细展开。

---

## 三、三种并发异常

```
时间线 →
事务 A                              事务 B
──────                              ──────
1. SELECT balance
   WHERE id=1 → 1000

                                    2. UPDATE balance=900
                                       WHERE id=1;
                                       COMMIT;

3. SELECT balance
   WHERE id=1 → ???

问题：A 的两次读取结果不一致！
```

| 并发异常 | 定义 | 影响 |
|---------|------|------|
| **脏读（Dirty Read）** | 读到了其他事务尚未提交的修改 | 数据不一致，回滚后读到"脏"数据 |
| **不可重复读（Non-Repeatable Read）** | 同一事务中两次读同一行结果不同 | 其他事务 UPDATE 已提交 |
| **幻读（Phantom Read）** | 同一事务中两次范围查询行数不同 | 其他事务 INSERT/DELETE 已提交 |

```
脏读场景：
  A: SELECT balance → 1000
  B: UPDATE balance=500 (未提交)
  A: SELECT balance → 500 (脏读！)
  B: ROLLBACK
  A 读到的 500 是一个从未真正存在的值

不可重复读场景：
  A: SELECT balance → 1000
  B: UPDATE balance=900; COMMIT;
  A: SELECT balance → 900 (不可重复读！)

幻读场景：
  A: SELECT COUNT(*) FROM orders → 100
  B: INSERT INTO orders VALUES(...); COMMIT;
  A: SELECT COUNT(*) FROM orders → 101 (幻读！)
```

---

## 四、SQL-92 隔离级别与 InnoDB 实现

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | InnoDB 实现 |
|---------|------|-----------|------|-------------|
| READ UNCOMMITTED | 可能 | 可能 | 可能 | 不加锁读取 |
| READ COMMITTED | 不会 | 可能 | 可能 | MVCC（每次读创建新 ReadView） |
| **REPEATABLE READ** | **不会** | **不会** | **可能** | **MVCC（事务首次读创建 ReadView）+ Gap Lock** |
| SERIALIZABLE | 不会 | 不会 | 不会 | 所有读加共享锁 |

```sql
-- 查看当前隔离级别
SELECT @@transaction_isolation;  -- MySQL 8.0+
SELECT @@tx_isolation;           -- MySQL 5.7

-- 设置隔离级别
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;

-- InnoDB 默认隔离级别：REPEATABLE READ
-- 大多数互联网应用使用 READ COMMITTED（如配合 Redis 缓存）
```

**InnoDB 的 REPEATABLE READ 如何解决幻读？**

InnoDB 在 RR 级别下通过 MVCC（快照读）和 Next-Key Lock（当前读）在很大程度上解决了幻读问题，后文详述。

---

## 五、MVCC 实现原理

MVCC（Multi-Version Concurrency Control）是 InnoDB 实现高并发读写的核心技术，核心思想是：**读不加锁，读写不冲突**。

### 5.1 隐藏列

InnoDB 为每行数据自动添加三个隐藏列：

```
┌──────────────────────────────────────────────────┐
│ DB_TRX_ID (6B)    │ 最近一次修改该行的事务 ID     │
│ DB_ROLL_PTR (7B)  │ 指向 Undo Log 版本链的指针    │
│ DB_ROW_ID (6B)    │ 隐藏行ID（无主键时自动生成）   │
└──────────────────────────────────────────────────┘
```

### 5.2 Undo Log 版本链

每次 UPDATE 都会将旧版本写入 Undo Log，并通过 roll_pointer 形成链表：

```
当前行 (Buffer Pool)
┌──────────────────────────────────┐
│ id=1, name='Dave', age=30        │
│ trx_id = 100                     │
│ roll_pointer ──────────────────┐ │
└────────────────────────────────┘ │
                                    │
                                    ▼
Undo Log 版本 1
┌──────────────────────────────────┐
│ id=1, name='Carol', age=28       │
│ trx_id = 80                      │
│ roll_pointer ──────────────────┐ │
└────────────────────────────────┘ │
                                    │
                                    ▼
Undo Log 版本 2（最早版本）
┌──────────────────────────────────┐
│ id=1, name='Alice', age=25       │
│ trx_id = 50                      │
│ roll_pointer = NULL              │
└──────────────────────────────────┘
```

### 5.3 ReadView（读视图）

ReadView 是 MVCC 的核心判断机制，包含以下关键信息：

```
ReadView 结构：
┌─────────────────────────────────────────────────────────┐
│ m_ids      │ 创建 ReadView 时所有活跃（未提交）事务 ID  │
│ min_trx_id │ m_ids 中的最小值（最早开始的活跃事务）      │
│ max_trx_id │ 系统即将分配的下一个事务 ID（最大 trx_id+1）│
│ creator_trx_id │ 创建该 ReadView 的事务 ID              │
└─────────────────────────────────────────────────────────┘
```

**可见性判断规则**：

```
对于版本链中的某个版本，其 trx_id 记为 T：

1. T == creator_trx_id
   → 可见（自己修改的行，当然可见）

2. T < min_trx_id
   → 可见（该事务在 ReadView 创建前已提交）

3. T >= max_trx_id
   → 不可见（该事务在 ReadView 创建后才开始）

4. min_trx_id <= T < max_trx_id
   → 检查 T 是否在 m_ids 中：
     - T 在 m_ids 中 → 不可见（该事务在 ReadView 创建时还未提交）
     - T 不在 m_ids 中 → 可见（该事务在 ReadView 创建前已提交）
```

```
可见性判断流程图：

         T == creator_trx_id?
              │
        ┌─────┴─────┐
        Yes         No
        │            │
      可见      T < min_trx_id?
                     │
               ┌─────┴─────┐
               Yes         No
               │            │
             可见      T >= max_trx_id?
                            │
                      ┌─────┴─────┐
                      Yes         No
                      │            │
                   不可见     T 在 m_ids 中?
                                    │
                              ┌─────┴─────┐
                              Yes         No
                              │            │
                           不可见       可见
```

### 5.4 快照读 vs 当前读

| 读类型 | 说明 | 使用的 ReadView |
|--------|------|----------------|
| **快照读（Snapshot Read）** | 普通 SELECT，读取 MVCC 版本链 | 事务首次 SELECT 时创建，后续复用 |
| **当前读（Current Read）** | SELECT FOR UPDATE / LOCK IN SHARE MODE / INSERT / UPDATE / DELETE | 读取最新已提交版本，并加锁 |

```sql
-- 快照读：普通 SELECT
SELECT * FROM users WHERE id = 1;

-- 当前读：加锁查询
SELECT * FROM users WHERE id = 1 FOR UPDATE;          -- 加排他锁 X
SELECT * FROM users WHERE id = 1 LOCK IN SHARE MODE;  -- 加共享锁 S

-- 当前读：写操作
UPDATE users SET age = 30 WHERE id = 1;   -- 先当前读再加 X 锁
DELETE FROM users WHERE id = 1;            -- 先当前读再加 X 锁
INSERT INTO users VALUES(1, 'Tom', 25);    -- 加插入意向锁 + X 锁
```

**RR 级别下 ReadView 的创建时机**：

```
REPEATABLE READ（InnoDB 默认）：
  事务 A:
    第一次 SELECT → 创建 ReadView（ReadView-1）
    第二次 SELECT → 复用 ReadView-1（所以两次结果一致）

READ COMMITTED：
  事务 A:
    第一次 SELECT → 创建 ReadView（ReadView-1）
    第二次 SELECT → 创建新的 ReadView（ReadView-2）
    → 如果中间有其他事务提交了修改，第二次能读到
```

---

## 六、锁机制概述

### 6.1 共享锁 S vs 排他锁 X

```
共享锁（Shared Lock / S Lock / 读锁）：
  - 多个事务可以同时持有同一行的 S 锁
  - 持有 S 锁的事务只能读取该行
  - SELECT ... LOCK IN SHARE MODE

排他锁（Exclusive Lock / X Lock / 写锁）：
  - 同一时刻只有一个事务能持有某行的 X 锁
  - 持有 X 锁的事务可以修改/删除该行
  - SELECT ... FOR UPDATE / INSERT / UPDATE / DELETE
```

### 6.2 意向锁 IS / IX

意向锁是表级锁，用于高效判断"表中是否有行级锁冲突"：

```
意向共享锁（IS）：表示事务打算给行加 S 锁
  → 加行 S 锁前，先加表 IS 锁

意向排他锁（IX）：表示事务打算给行加 X 锁
  → 加行 X 锁前，先加表 IX 锁

作用：
  没有意向锁时，给表加 X 锁需要逐行检查是否有行锁 → O(N)
  有意向锁后，只需检查表级意向锁 → O(1)
```

### 6.3 锁兼容性矩阵

```
           已持有的锁
请求的锁    IS    IX    S     X
─────────────────────────────────
IS          ✅    ✅    ✅    ❌
IX          ✅    ✅    ❌    ❌
S           ✅    ❌    ✅    ❌
X           ❌    ❌    ❌    ❌

✅ = 兼容，可以同时持有
❌ = 冲突，需要等待
```

**解读**：
- IS 与 IS 兼容：多个事务同时读同一张表
- IX 与 IX 兼容：多个事务同时写同一张表的不同行
- S 与 IX 冲突：有人要读锁全表，有人要写某行 → 冲突
- X 与一切冲突：排他锁独占

---

## 七、行级锁详解

InnoDB 的行锁是加在**索引记录**上的，不是加在物理行上。如果没有走索引，InnoDB 会退化为表锁。

### 7.1 Record Lock（记录锁）

```sql
-- 锁定 id=5 这一行的索引记录
SELECT * FROM users WHERE id = 5 FOR UPDATE;

-- 只锁定 id=5 的记录，其他行不受影响
-- 其他事务可以正常操作 id=1, id=2, ...
```

### 7.2 Gap Lock（间隙锁）

Gap Lock 锁定索引记录之间的"间隙"，防止其他事务在间隙中插入新行：

```
索引记录:  [id=5]    [id=10]    [id=15]
间隙:    (负无穷,5) (5,10)    (10,15)   (15,正无穷)

-- 锁定 id=10 所在的间隙 (5, 10)
SELECT * FROM users WHERE id = 10 FOR UPDATE;

-- 在 RR 级别下，这条语句会加 Gap Lock
-- 效果：其他事务无法 INSERT id=6,7,8,9
-- 目的：防止幻读
```

### 7.3 Next-Key Lock（临键锁）

Next-Key Lock = Record Lock + Gap Lock，锁定范围是**左开右闭**区间：

```
索引记录:  [id=5]    [id=10]    [id=15]

Next-Key Lock 锁定 id=10 时：
  锁定范围: (5, 10]  ← 左开右闭

  即锁定了：
  - 间隙 (5, 10)  ← Gap Lock 部分
  - 记录 id=10    ← Record Lock 部分

具体行为：
  SELECT * FROM users WHERE id = 10 FOR UPDATE;
  → 其他事务无法 INSERT id=6,7,8,9（Gap 保护）
  → 其他事务无法 UPDATE/DELETE id=10（Record 保护）
  → 其他事务可以 INSERT id=11（不在锁定范围内）
```

```sql
-- 范围查询的 Next-Key Lock 示例
SELECT * FROM users WHERE id > 5 AND id < 15 FOR UPDATE;

-- 锁定范围：(5, 10] 和 (10, 15)
-- 实际效果：
-- id=5 的记录不锁（左开）
-- id=10 的记录被锁（Record Lock）
-- (5,10) 的间隙被锁（Gap Lock）
-- id=15 的记录不锁
-- (10,15) 的间隙被锁

-- 注意：唯一索引等值查询只加 Record Lock，不加 Gap Lock
-- 非唯一索引或范围查询会加 Next-Key Lock
```

### 7.4 Insert Intention Lock（插入意向锁）

插入意向锁是特殊的 Gap Lock，允许多个事务同时向同一个 Gap 的不同位置插入：

```
Gap: (5, 10)

事务 A: INSERT id=7  → 获取 (5,10) 的插入意向锁
事务 B: INSERT id=8  → 获取 (5,10) 的插入意向锁 ← 不冲突！

插入意向锁与 Gap Lock 的关系：
  - Gap Lock 持有者阻塞其他事务的 Insert Intention Lock
  - Insert Intention Lock 之间互相兼容
  - 这就是为什么"不同位置插入不互斥"
```

---

## 八、锁的粒度

### 8.1 全局锁

```sql
-- 全库只读锁，用于一致性备份
FLUSH TABLES WITH READ LOCK;  -- FTWRL

-- 效果：
-- 所有表的 DML（INSERT/UPDATE/DELETE）被阻塞
-- 所有表的 DDL 被阻塞
-- 只允许 SELECT

-- 释放
UNLOCK TABLES;

-- 更好的备份方式：
-- 使用 mysqldump --single-transaction
-- 利用 MVCC 快照，不需要全局锁
```

### 8.2 表级锁

**AUTO-INC 锁**：用于自增主键的分配。

```
三种 AUTO-INC 模式（innodb_autoinc_lock_mode）：

模式 0（传统模式）：
  - 每次 INSERT 获取表级 AUTO-INC 锁
  - 语句结束后才释放
  - 最安全，但并发最低

模式 1（连续模式，默认）：
  - 简单 INSERT（确定行数）：使用轻量级互斥锁，分配完立即释放
  - 批量 INSERT（不确定行数，如 INSERT...SELECT）：仍用表级锁
  - 平衡安全与性能

模式 2（交错模式）：
  - 所有 INSERT 都使用轻量级互斥锁
  - 并发最高，但自增 ID 可能不连续
  - 主从复制需要 binlog_format=ROW
```

**MDL（元数据锁）**：

```
MDL 自动管理，防止 DDL 与 DML 冲突：

  事务 A: SELECT * FROM users;      → 获取 MDL 共享读锁
  事务 B: ALTER TABLE users ADD COLUMN age INT; → 需要 MDL 排他锁 → 被阻塞
  事务 C: SELECT * FROM users;      → 需要 MDL 共享读锁 → 被 B 阻塞

  注意：事务 B 的 DDL 等待事务 A 释放 MDL
  此时所有新的查询也会被事务 B 阻塞
  这就是著名的 "MDL 雪崩" 问题！

解决 MDL 阻塞：
  ALTER TABLE ... ADD COLUMN ..., ALGORITHM=INSTANT;  -- 8.0.12+
  pt-online-schema-change  -- Percona 工具
  gh-ost  -- GitHub 开源工具
```

### 8.3 行级锁

行级锁是 InnoDB 最常用的锁粒度，加在索引记录上。详见第七章。

---

## 九、乐观锁 vs 悲观锁

### 9.1 悲观锁

悲观锁假设冲突一定会发生，操作前先加锁：

```sql
-- 悲观锁实现扣库存
BEGIN;
SELECT stock FROM products WHERE id = 1 FOR UPDATE;  -- 加 X 锁
-- 检查 stock > 0
UPDATE products SET stock = stock - 1 WHERE id = 1;
COMMIT;

-- 优点：保证数据一致性
-- 缺点：并发低，持锁时间长，可能死锁
```

### 9.2 乐观锁

乐观锁假设冲突概率低，先操作再检测冲突：

```sql
-- 表增加 version 字段
ALTER TABLE products ADD COLUMN version INT DEFAULT 0;

-- 乐观锁实现（版本号 + CAS）
-- 步骤 1：读取当前值和版本号
SELECT stock, version FROM products WHERE id = 1;
-- 得到 stock=10, version=5

-- 步骤 2：CAS 更新（Compare And Swap）
UPDATE products
SET stock = stock - 1, version = version + 1
WHERE id = 1 AND version = 5;

-- 如果 affected rows = 0，说明有人抢先修改了
-- 应用程序重试整个流程
```

### 9.3 选择策略

```
冲突率评估：
┌─────────────────────────────────────────────────────┐
│ 冲突率 < 10%  → 乐观锁（重试成本低，并发高）        │
│ 冲突率 10~50% → 视业务场景选择                       │
│ 冲突率 > 50%  → 悲观锁（重试成本高，不如直接加锁）   │
└─────────────────────────────────────────────────────┘

分段锁优化（类似 ConcurrentHashMap）：
  热点资源拆分为多个子资源，降低冲突概率
  例如：总库存 1000 → 拆为 10 个分段，每段 100
```

---

## 十、死锁防治

### 10.1 死锁的形成

```
死锁的经典场景：

时间线 →
事务 A                              事务 B
──────                              ──────
1. UPDATE accounts
   SET balance=900
   WHERE id=1;                      2. UPDATE accounts
   (获得 id=1 的 X 锁)                 SET balance=400
                                       WHERE id=2;
                                       (获得 id=2 的 X 锁)

3. UPDATE accounts                  4. UPDATE accounts
   SET balance=300                     SET balance=500
   WHERE id=2;                         WHERE id=1;
   (等待 id=2 的 X 锁) ←──────→      (等待 id=1 的 X 锁)

   ← 死锁！双方互相等待对方释放锁 →
```

### 10.2 Wait-for Graph 检测

InnoDB 使用**等待图（Wait-for Graph）**实时检测死锁：

```
等待图示例：
  事务 A ──等待──→ 事务 B ──等待──→ 事务 A
  （形成环路 → 死锁！）

检测算法：
  - 每次事务请求锁被阻塞时，在等待图中添加一条边
  - 检查是否形成环路
  - 如果形成环路，选择"代价最小"的事务回滚

回滚策略：
  - 选择 undo log 最少的事务回滚（回滚代价最小）
  - 被回滚的事务收到错误：ERROR 1213 (40001): Deadlock found
```

```sql
-- 查看死锁日志
SHOW ENGINE INNODB STATUS;
-- 在输出中搜索 "LATEST DETECTED DEADLOCK"

-- 死锁检测开关（高并发场景可关闭检测，改用锁超时）
SET GLOBAL innodb_deadlock_detect = ON;  -- 默认开启

-- 锁等待超时时间
SET GLOBAL innodb_lock_wait_timeout = 10;  -- 默认 50 秒
```

### 10.3 死锁的 5 种常见根因

```
根因 1：事务操作顺序不一致
  解决：所有事务按相同顺序访问资源

根因 2：事务持有锁时间过长
  解决：缩短事务，将耗时操作移出事务

根因 3：大事务操作多行数据
  解决：拆分大事务为小事务

根因 4：未走索引导致行锁升级为表锁
  解决：确保 WHERE 条件走索引

根因 5：Gap Lock 导致的插入死锁
  解决：降低隔离级别为 READ COMMITTED（无 Gap Lock）
```

### 10.4 死锁预防策略

```sql
-- 策略 1：统一加锁顺序
-- 所有转账操作都先锁小 ID，再锁大 ID
UPDATE accounts SET balance = balance - 100 WHERE id = LEAST(1, 2);
UPDATE accounts SET balance = balance + 100 WHERE id = GREATEST(1, 2);

-- 策略 2：缩短事务
-- ❌ 坏做法
BEGIN;
CALL external_api();  -- 耗时 2 秒
UPDATE users SET ...;
COMMIT;

-- ✅ 好做法
result = CALL external_api();  -- 在事务外调用
BEGIN;
UPDATE users SET ... = result;
COMMIT;

-- 策略 3：合理设置隔离级别
-- 如果能容忍，使用 READ COMMITTED（无 Gap Lock，减少死锁概率）
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- 策略 4：使用 SELECT ... FOR UPDATE NOWAIT（8.0+）
SELECT * FROM accounts WHERE id = 1 FOR UPDATE NOWAIT;
-- 如果无法立即获取锁，直接报错而非等待
-- 应用程序捕获异常后重试

-- 策略 5：使用 SKIP LOCKED（8.0+）
SELECT * FROM task_queue WHERE status = 0 LIMIT 1 FOR UPDATE SKIP LOCKED;
-- 跳过已被锁定的行，适合任务队列场景
```

---

## 十一、幻读防治

### 11.1 快照读的保护（MVCC）

在 RR 级别下，普通 SELECT 使用快照读，MVCC 机制天然防止幻读：

```sql
-- 事务 A（快照读）
BEGIN;
SELECT COUNT(*) FROM orders WHERE user_id = 1;  -- 结果: 5
-- 此时 MVCC ReadView 已创建

-- 事务 B
BEGIN;
INSERT INTO orders(user_id, amount) VALUES(1, 99.9);
COMMIT;

-- 事务 A 再次查询
SELECT COUNT(*) FROM orders WHERE user_id = 1;  -- 结果仍然是 5！
-- MVCC 保护：新插入的行 trx_id > ReadView 的 max_trx_id → 不可见
```

### 11.2 当前读的保护（Next-Key Lock）

对于当前读（FOR UPDATE / 写操作），MVCC 无法保护，需要 Next-Key Lock：

```sql
-- 事务 A（当前读）
BEGIN;
SELECT * FROM orders WHERE user_id = 1 FOR UPDATE;
-- 对匹配的索引记录加 Next-Key Lock
-- 同时锁定相关的 Gap，防止新行插入

-- 事务 B
BEGIN;
INSERT INTO orders(user_id, amount) VALUES(1, 99.9);
-- 被 Gap Lock 阻塞！必须等待事务 A 提交或回滚

-- 事务 A
COMMIT;  -- Gap Lock 释放，事务 B 的 INSERT 可以执行
```

### 11.3 幻读防治失效的 3 种场景

```
场景 1：先快照读，后当前读
  事务 A:
    SELECT * FROM orders WHERE user_id=1;         -- 快照读，5 行
    -- 事务 B: INSERT 一行并提交
    SELECT * FROM orders WHERE user_id=1 FOR UPDATE;  -- 当前读，6 行！
    → 幻读发生！因为当前读总是读最新版本

场景 2：先当前读，后快照读
  事务 A:
    SELECT * FROM orders WHERE user_id=1 FOR UPDATE;  -- 当前读，5 行
    -- 事务 B: INSERT 一行并提交
    SELECT * FROM orders WHERE user_id=1;             -- 快照读，仍然是 5 行
    → 这种情况不出现幻读（ReadView 在当前读时创建）

场景 3：UPDATE 触发"幻象可见"
  事务 A:
    SELECT * FROM t WHERE id=1 FOR UPDATE;  -- 不存在
    -- 事务 B: INSERT INTO t VALUES(1, 10); COMMIT;
    -- 事务 C: INSERT INTO t VALUES(1, 20); COMMIT;
    UPDATE t SET val=100 WHERE id=1;        -- 更新了哪一行？
    SELECT * FROM t WHERE id=1;             -- 快照读可能看到意外结果
```

---

## 十二、实战：锁监控与排查

```sql
-- 查看当前锁等待情况（MySQL 8.0+）
SELECT * FROM information_schema.innodb_locks;        -- 5.7
SELECT * FROM performance_schema.data_locks;          -- 8.0+

-- 查看锁等待关系
SELECT * FROM information_schema.innodb_lock_waits;   -- 5.7
SELECT * FROM performance_schema.data_lock_waits;     -- 8.0+

-- 查看当前运行的事务
SELECT * FROM information_schema.innodb_trx;

-- 综合查询：谁阻塞了谁
SELECT
    waiting.trx_id AS '等待事务',
    blocking.trx_id AS '阻塞事务',
    waiting.trx_query AS '等待SQL',
    r.trx_started AS '等待开始时间'
FROM performance_schema.data_lock_waits w
JOIN information_schema.innodb_trx waiting ON w.requesting_engine_transaction_id = waiting.trx_id
JOIN information_schema.innodb_trx blocking ON w.blocking_engine_transaction_id = blocking.trx_id;

-- 杀掉阻塞的事务
KILL <thread_id>;
```

---

## 十三、面试题精选

### Q1：InnoDB 如何实现 MVCC？

**答**：MVCC 通过 Undo Log 版本链和 ReadView 实现。每行数据有隐藏列 trx_id（最后修改的事务 ID）和 roll_pointer（指向 Undo Log 旧版本）。事务执行 SELECT 时创建 ReadView，根据 ReadView 中的活跃事务列表判断版本链中哪个版本对当前事务可见，从而读取到"快照"版本的数据，无需加锁。

### Q2：RR 级别下 InnoDB 完全解决了幻读吗？

**答**：大部分场景下解决了。快照读通过 MVCC 天然防止幻读；当前读通过 Next-Key Lock 阻塞并发插入。但在"先快照读、后当前读"的混合场景下仍可能出现幻读现象，这是 RR 级别的已知限制，需要 SERIALIZABLE 级别才能完全避免。

### Q3：Undo Log 和 Redo Log 的区别？

**答**：Redo Log 是物理日志，记录"在哪个数据页做了什么修改"，用于崩溃恢复（保证持久性）。Undo Log 是逻辑日志，记录修改前的旧数据，用于事务回滚（保证原子性）和 MVCC 多版本读取（保证隔离性）。Redo Log 循环写入固定大小文件，Undo Log 存储在系统表空间和独立表空间中。

### Q4：什么情况下行锁会升级为表锁？

**答**：当 SQL 语句未使用索引进行 WHERE 过滤时，InnoDB 无法定位到具体的索引记录，只能对全表所有行加锁，退化为表锁。因此，确保 UPDATE/DELETE 的 WHERE 条件命中索引是避免锁升级的关键。

### Q5：死锁发生时 InnoDB 怎么处理？

**答**：InnoDB 通过 Wait-for Graph 实时检测死锁。发现环路后，选择 undo log 最少（回滚代价最小）的事务进行回滚，返回 `ERROR 1213 (40001): Deadlock found when trying to get lock`。应用程序应捕获此异常并进行重试。

### Q6：为什么 MySQL 默认隔离级别是 RR 而不是 RC？

**答**：历史原因——在 MySQL 5.0 之前，Binlog 使用 STATEMENT 格式（记录 SQL 语句）。在 RC 级别下，STATEMENT 格式的 Binlog 在主从复制时可能导致从库数据不一致。RR 级别配合 Gap Lock 可以保证 STATEMENT 格式 Binlog 的复制正确性。现代生产环境使用 ROW 格式 Binlog + RC 级别是更常见的选择。

### Q7：SELECT FOR UPDATE 和 LOCK IN SHARE MODE 的区别？

**答**：SELECT ... FOR UPDATE 加排他锁（X），其他事务既不能读（加锁读）也不能写。SELECT ... LOCK IN SHARE MODE 加共享锁（S），其他事务可以加 S 锁读取，但不能加 X 锁修改。如果后续有更新意图，应使用 FOR UPDATE，避免 S 锁升级到 X 锁时死锁。MySQL 8.0+ 新增 FOR SHARE 语法替代 LOCK IN SHARE MODE。

---

## 十四、总结

```
事务与锁知识体系：

1. ACID 实现：原子性(Undo)、持久性(Redo)、隔离性(MVCC+锁)
2. MVCC 核心：Undo 版本链 + ReadView 可见性判断
3. 快照读用 MVCC，当前读用锁
4. 行锁三兄弟：Record Lock / Gap Lock / Next-Key Lock
5. 死锁防治：统一顺序、缩短事务、NOWAIT/SKIP LOCKED
6. 幻读治理：MVCC 保护快照读，Next-Key Lock 保护当前读
7. 生产建议：ROW Binlog + RC 级别是现代互联网首选
```

> 下一篇预告：《MySQL SQL 优化实战——执行计划、慢查询与性能调优》，从 EXPLAIN 到参数调优的全面指南。
