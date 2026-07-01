# MySQL SQL 优化实战——执行计划、慢查询与性能调优

> 一条慢 SQL 可以拖垮整个数据库。本文从 MySQL 架构解析入手，系统讲解 EXPLAIN 执行计划分析、慢查询日志诊断、JOIN/ORDER BY/深度分页优化，以及核心参数调优和研发规范，是 MySQL 性能优化的完整指南。

---

## 一、MySQL 架构全景

MySQL 采用分层架构，理解各层职责是优化的基础：

```
┌─────────────────────────────────────────────────────┐
│                    客户端应用层                       │
│           (JDBC / ODBC / ORM / CLI)                  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Server 层                          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ 连接器   │→│ 分析器    │→│ 优化器             │ │
│  │Connector │  │Parser    │  │Optimizer           │ │
│  │(认证/权限)│  │(词法/语法)│  │(代价模型/执行计划) │ │
│  └──────────┘  └──────────┘  └─────────┬──────────┘ │
│                                         │            │
│                                ┌────────▼─────────┐ │
│                                │ 执行器            │ │
│                                │Executor          │ │
│                                │(调用存储引擎)     │ │
│                                └────────┬─────────┘ │
└─────────────────────────────────────────┼────────────┘
                                          │
┌─────────────────────────────────────────▼────────────┐
│                  存储引擎层                            │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ InnoDB   │  │ MyISAM   │  │ Memory   │  ...      │
│  │(默认引擎) │  │(不支持事务)│ │(内存引擎) │           │
│  └──────────┘  └──────────┘  └──────────┘           │
└──────────────────────────────────────────────────────┘

各层职责：
┌─────────────────────────────────────────────────────┐
│ 连接器：建立连接、验证账号密码、管理连接权限          │
│ 分析器：词法分析（识别关键字/表名/列名）              │
│         语法分析（构建抽象语法树 AST）               │
│ 优化器：基于代价模型选择最优执行计划                   │
│         索引选择、JOIN 顺序、子查询改写               │
│ 执行器：根据执行计划调用存储引擎接口                  │
│         权限验证、结果返回                           │
└─────────────────────────────────────────────────────┘
```

```sql
-- 查看 MySQL 版本
SELECT VERSION();

-- 查看当前连接信息
SHOW PROCESSLIST;

-- 查看存储引擎
SHOW ENGINES;
SHOW VARIABLES LIKE 'default_storage_engine';
```

---

## 二、SQL 逻辑执行顺序

SQL 语句的书写顺序和实际执行顺序不同，理解执行顺序是写出高效 SQL 的前提：

```
书写顺序：
  SELECT → DISTINCT → FROM → JOIN → ON → WHERE →
  GROUP BY → HAVING → ORDER BY → LIMIT

实际执行顺序：
  1. FROM        ── 确定数据来源，加载表
  2. JOIN        ── 表连接（ON 条件过滤）
  3. WHERE       ── 行级过滤
  4. GROUP BY    ── 分组
  5. HAVING      ── 分组后过滤
  6. SELECT      ── 选择列、计算表达式
  7. DISTINCT    ── 去重
  8. ORDER BY    ── 排序
  9. LIMIT       ── 限制返回行数
```

**优化启示**：

```sql
-- WHERE 在 GROUP BY 之前执行 → 尽量在 WHERE 中过滤
-- ❌ 效率低
SELECT department, COUNT(*) AS cnt
FROM employees
GROUP BY department
HAVING cnt > 10;

-- ✅ 如果能提前过滤，用 WHERE 减少分组的数据量
SELECT department, COUNT(*) AS cnt
FROM employees
WHERE status = 'active'  -- 提前过滤离职员工
GROUP BY department
HAVING cnt > 10;

-- WHERE 不能用聚合函数，HAVING 可以
-- 因为 WHERE 在 GROUP BY 之前，聚合还没发生
```

---

## 三、EXPLAIN 执行计划详解

EXPLAIN 是 SQL 优化的核心工具，能展示优化器选择的执行计划：

```sql
EXPLAIN SELECT * FROM orders o
JOIN users u ON o.user_id = u.id
WHERE u.city = 'Shanghai' AND o.amount > 100\G
```

### 3.1 EXPLAIN 输出 12 个字段

| 字段 | 含义 | 关注程度 |
|------|------|---------|
| id | 查询编号，标识 SELECT 的层级 | ★★★ |
| select_type | 查询类型（SIMPLE/PRIMARY/SUBQUERY...） | ★★☆ |
| table | 当前行访问的表 | ★★★ |
| partitions | 匹配的分区 | ★☆☆ |
| **type** | **访问类型（最重要字段之一）** | **★★★** |
| possible_keys | 可能使用的索引 | ★★★ |
| **key** | **实际使用的索引** | **★★★** |
| **key_len** | **索引使用的字节长度** | **★★★** |
| ref | 索引的哪一列被使用了 | ★★☆ |
| **rows** | **预估扫描行数** | **★★★** |
| **filtered** | **经过条件过滤后的行百分比** | **★★★** |
| **Extra** | **额外信息（关键优化提示）** | **★★★** |

### 3.2 type 访问类型层级（从好到坏）

```
性能从优到劣：

system  >  const  >  eq_ref  >  ref  >  range  >  index  >  ALL
  ↑                                                        ↑
 最好                                                     最差

详细说明：

system   : 表只有一行（系统表），无需读取
const    : 通过主键/唯一索引等值查询，最多返回 1 行
eq_ref   : JOIN 时通过主键/唯一索引关联，每次只匹配 1 行
ref      : 通过普通索引等值查询，可能匹配多行
range    : 索引范围扫描（BETWEEN, >, <, IN）
index    : 全索引扫描（遍历整棵索引树，但不读数据文件）
ALL      : 全表扫描（最差情况，无任何索引可用）
```

```sql
-- const 示例：主键等值
EXPLAIN SELECT * FROM users WHERE id = 1;
-- type: const

-- eq_ref 示例：JOIN 主键关联
EXPLAIN SELECT * FROM orders o
JOIN users u ON o.user_id = u.id;
-- users 表的 type: eq_ref（如果 user_id 是 users 的主键）

-- ref 示例：普通索引等值
EXPLAIN SELECT * FROM orders WHERE user_id = 100;
-- type: ref（user_id 有普通索引）

-- range 示例：索引范围
EXPLAIN SELECT * FROM orders WHERE id > 100 AND id < 200;
-- type: range
```

### 3.3 key_len 计算规则

key_len 表示索引使用的字节数，可以判断联合索引用到了几列：

```
key_len 计算方法：
┌─────────────────────────────────────────────────────┐
│ 字段类型        │ 字节数                             │
│─────────────────│───────────────────────────────────│
│ TINYINT         │ 1                                 │
│ SMALLINT        │ 2                                 │
│ INT             │ 4                                 │
│ BIGINT          │ 8                                 │
│ DATE            │ 3                                 │
│ DATETIME        │ 5                                 │
│ TIMESTAMP       │ 4                                 │
│ CHAR(n)         │ n * 字符集字节数(utf8mb4=4)       │
│ VARCHAR(n)      │ n * 字符集字节数 + 2（长度标识）   │
└─────────────────────────────────────────────────────┘

允许 NULL 的列额外 +1 字节

示例：联合索引 idx_abc(a INT, b VARCHAR(50), c DATE)
  字符集 utf8mb4，所有列 NOT NULL：
  a: 4 字节
  b: 50 * 4 + 2 = 202 字节
  c: 3 字节

  如果 key_len = 4   → 只用了 a
  如果 key_len = 206 → 用了 a, b
  如果 key_len = 209 → 用了 a, b, c
```

### 3.4 Extra 字段分析

| Extra 值 | 含义 | 优化建议 |
|----------|------|---------|
| Using index | 覆盖索引，无需回表 | 最佳状态 |
| Using index condition | ICP 索引条件下推 | 较好 |
| Using where | Server 层过滤 | 正常 |
| Using filesort | 需要额外排序 | 考虑添加排序索引 |
| Using temporary | 需要临时表（GROUP BY / DISTINCT） | 必须优化 |
| Using join buffer (Block Nested Loop) | JOIN 没有用到索引 | 为被驱动表加索引 |
| Select tables optimized away | 优化器直接从索引获取结果 | 最优 |

```sql
-- 查看完整的 EXPLAIN 输出（JSON 格式更详细）
EXPLAIN FORMAT=JSON SELECT * FROM orders WHERE user_id = 100\G

-- 查看优化器实际执行代价
EXPLAIN FORMAT=TREE SELECT * FROM orders WHERE user_id = 100\G
```

---

## 四、慢查询日志

### 4.1 开启慢查询日志

```sql
-- 查看是否开启
SHOW VARIABLES LIKE 'slow_query_log%';

-- 动态开启（无需重启）
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;         -- 超过 1 秒记录
SET GLOBAL log_queries_not_using_indexes = ON;  -- 未使用索引的查询也记录

-- 持久化配置（my.cnf）
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 1
log_queries_not_using_indexes = 1
```

### 4.2 mysqldumpslow 分析

```bash
# 按平均耗时排序，取 Top 10
mysqldumpslow -s at -t 10 /var/log/mysql/slow.log

# 按执行次数排序
mysqldumpslow -s c -t 10 /var/log/mysql/slow.log

# 按锁等待时间排序
mysqldumpslow -s al -t 10 /var/log/mysql/slow.log

# 参数说明：
# -s  排序方式：at(平均时间), c(次数), al(平均锁时间), ar(平均返回行数)
# -t  显示前 N 条
# -g  匹配正则表达式：-g "SELECT.*orders"
```

### 4.3 pt-query-digest（推荐）

```bash
# Percona Toolkit 的 pt-query-digest 是更专业的慢查询分析工具
pt-query-digest /var/log/mysql/slow.log > /tmp/slow_report.txt

# 输出包含：
# - 查询指纹（参数化后的 SQL 模板）
# - 执行次数、总耗时、平均耗时、锁时间
# - 95th 百分位耗时
# - EXPLAIN 结果

# 分析指定时间段的慢查询
pt-query-digest --since '2024-01-01 00:00:00' \
                --until '2024-01-31 23:59:59' \
                /var/log/mysql/slow.log

# 分析特定数据库的慢查询
pt-query-digest --filter '$event->{db} eq "myapp"' /var/log/mysql/slow.log
```

---

## 五、JOIN 优化

### 5.1 Nested Loop Join 三种变体

```
1. Simple Nested Loop Join (SNLJ)
   对驱动表每一行，扫描被驱动表全部行
   复杂度：O(N × M)  ← 极差，MySQL 不使用

2. Index Nested Loop Join (INLJ)
   对驱动表每一行，通过索引查找被驱动表
   复杂度：O(N × log M)  ← 被驱动表关联列有索引时
   关键：被驱动表的关联列必须有索引！

3. Block Nested Loop Join (BNLJ)
   驱动表数据批量放入 join_buffer，被驱动表扫描一次比对所有缓冲行
   复杂度：O(N/buffer × M)  ← 被驱动表无索引时的优化
   MySQL 8.0.18+ 被 Hash Join 替代
```

### 5.2 Hash Join（MySQL 8.0.18+）

```sql
-- Hash Join 原理：
-- 1. 对较小的表构建 Hash 表（内存）
-- 2. 扫描较大的表，逐行在 Hash 表中查找匹配
-- 3. 时间复杂度：O(N + M) ← 最优

-- Hash Join 自动启用条件：
-- - 没有索引可用的等值 JOIN
-- - MySQL 8.0.18+ 版本

-- 手动控制 Hash Join
SET optimizer_switch = 'hash_join=on';  -- 默认开启

-- 使用 Hint 强制 Hash Join
SELECT /*+ HASH_JOIN(table_name) */ *
FROM orders o JOIN users u ON o.user_id = u.id;
```

### 5.3 驱动表选择原则

```
核心原则：小表驱动大表

原因（Index NLJ）：
  驱动表 N 行，被驱动表 M 行
  总 IO = N × (被驱动表索引查找 IO)
  N 越小，总 IO 越少

示例：
  orders 表 100 万行
  users 表 1 万行

  ✅ 正确：users 驱动 orders（1 万次 × log(100万)）
  SELECT * FROM users u JOIN orders o ON u.id = o.user_id;

  ❌ 错误：orders 驱动 users（100 万次 × log(1万)）
  SELECT * FROM orders o JOIN users u ON o.user_id = u.id;

注意：优化器通常能自动选择正确的驱动表
      使用 STRAIGHT_JOIN 可以强制指定驱动表（慎用）
```

### 5.4 JOIN 优化 6 条策略

```
策略 1：被驱动表关联列必须有索引
  → 确保 JOIN ON 条件中的列有索引

策略 2：小表驱动大表
  → 让行数少的表作为驱动表

策略 3：避免在 JOIN 条件中使用函数或表达式
  → 会导致索引失效

策略 4：减少 JOIN 的表数量
  → 超过 3 个表的 JOIN 考虑拆分

策略 5：确保 JOIN 列的数据类型一致
  → 类型不一致会导致隐式转换，索引失效

策略 6：避免使用子查询，改写为 JOIN
  → 子查询可能产生临时表，JOIN 效率更高
```

```sql
-- ❌ 子查询方式
SELECT * FROM users
WHERE id IN (SELECT user_id FROM orders WHERE amount > 1000);

-- ✅ JOIN 方式（通常更快）
SELECT DISTINCT u.* FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE o.amount > 1000;
```

---

## 六、ORDER BY 优化

### 6.1 两种排序方式

```
1. 索引排序（Using index）
   直接利用索引的有序性返回数据，无需额外排序
   条件：ORDER BY 列与索引顺序一致

2. Filesort（文件排序）
   MySQL 在内存或磁盘中对结果集进行额外排序
   Extra 显示 "Using filesort"
```

### 6.2 Filesort 的两种算法

```
1. 全字段排序
   将排序列和所有查询列一起放入 sort buffer
   排序后直接返回结果，无需回表
   优点：减少回表 IO
   缺点：sort buffer 中每行数据较大，能缓存的行数少

2. rowid 排序（MySQL 4.1+）
   sort buffer 中只存放排序列 + 主键
   排序后根据主键回表取完整数据
   优点：sort buffer 每行小，能缓存更多行
   缺点：排序后需要额外回表

选择标准：
  max_length_for_sort_data 参数（默认 1024）
  如果 查询列总长度 > max_length_for_sort_data → rowid 排序
  否则 → 全字段排序
```

```sql
-- ✅ 利用索引排序
CREATE INDEX idx_status_created ON orders(status, created_at);
SELECT * FROM orders WHERE status = 1 ORDER BY created_at;
-- 索引 idx_status_created 天然按 created_at 排序，无需 filesort

-- ❌ 无法利用索引排序
SELECT * FROM orders WHERE status = 1 ORDER BY amount;
-- status 有索引但 amount 无索引，需要 filesort

-- 优化：创建覆盖排序的联合索引
CREATE INDEX idx_status_amount ON orders(status, amount);
```

### 6.3 sort_buffer_size 调优

```sql
-- sort_buffer_size：每个排序线程分配的内存
SHOW VARIABLES LIKE 'sort_buffer_size';
-- 默认 256KB

-- 如果 sort buffer 不够用，会使用磁盘临时文件排序（极慢）
-- 监控排序相关状态：
SHOW STATUS LIKE 'Sort%';
-- Sort_merge_passes: 排序合并次数（越大说明 buffer 越不够用）
-- Sort_scan: 通过扫描排序的次数
-- Sort_range: 通过范围排序的次数

-- 建议：
-- 全局 sort_buffer_size 不要设太大（每个连接都会分配）
-- 只在需要大排序的会话中临时调大
SET SESSION sort_buffer_size = 4 * 1024 * 1024;  -- 4MB
```

---

## 七、深度分页优化

### 7.1 LIMIT 的工作机制

```sql
-- LIMIT offset, count 的实际执行过程：
SELECT * FROM orders ORDER BY id LIMIT 100000, 10;

-- MySQL 实际做了：
-- 1. 扫描满足条件的 100010 行
-- 2. 丢弃前 100000 行
-- 3. 返回后 10 行
-- 越往后翻页越慢！
```

```
LIMIT 性能随 offset 增长而下降：

LIMIT 0, 10        → 扫描 10 行      → 1ms
LIMIT 1000, 10     → 扫描 1010 行    → 5ms
LIMIT 100000, 10   → 扫描 100010 行  → 150ms  ⚠️
LIMIT 1000000, 10  → 扫描 1000010 行 → 1.5s   ❌ 很慢
```

### 7.2 深度分页优化策略

**策略一：子查询 + JOIN**

```sql
-- 原始慢查询
SELECT * FROM orders ORDER BY id LIMIT 1000000, 10;

-- 优化：先用覆盖索引定位 ID，再 JOIN 取完整数据
SELECT o.* FROM orders o
INNER JOIN (
    SELECT id FROM orders ORDER BY id LIMIT 1000000, 10
) AS tmp ON o.id = tmp.id;

-- 子查询只扫描主键索引（覆盖索引），速度快
-- 只回表 10 次
```

**策略二：子查询 + 范围条件**

```sql
-- 利用上一页最后一条记录的 ID
SELECT * FROM orders
WHERE id > (SELECT id FROM orders ORDER BY id LIMIT 1000000, 1)
ORDER BY id LIMIT 10;

-- 等价于利用主键范围扫描，避免扫描前 100 万行
```

**策略三：游标式（推荐）**

```sql
-- 客户端记住上一页最后一条记录的 ID
-- 第一页：
SELECT * FROM orders ORDER BY id LIMIT 10;
-- 假设最后一条 id = 10

-- 第二页（不使用 OFFSET）：
SELECT * FROM orders WHERE id > 10 ORDER BY id LIMIT 10;

-- 第三页：
SELECT * FROM orders WHERE id > 20 ORDER BY id LIMIT 10;

-- 优点：无论翻到第几页，性能恒定
-- 缺点：只能顺序翻页，不能跳页
-- 适合：无限滚动加载（瀑布流/信息流）
```

**策略四：Elasticsearch Scroll**

```
对于大数据量分页场景，将数据同步到 Elasticsearch：

MySQL                    Elasticsearch
┌──────┐                ┌──────────────┐
│Orders│ ── Canal ──→  │ ES Index     │
│Table │   实时同步     │ (倒排索引)   │
└──────┘                └──────────────┘

ES scroll API / search_after：
  - 适合百万级深度分页
  - 支持任意排序和复杂过滤
  - 适合搜索+分页场景
```

---

## 八、查询缓存与现代替代方案

### 8.1 MySQL 查询缓存（8.0 已移除）

```
MySQL Query Cache 的问题：
┌─────────────────────────────────────────────────────┐
│ 1. 缓存以 SQL 文本为 key → SQL 微小变化就 miss      │
│ 2. 任何表修改都会失效该表所有缓存 → 写入密集时负优化 │
│ 3. 缓存清理需要加锁 → 高并发下锁竞争严重             │
│ 4. 缓存大小有限（query_cache_size） → 命中率低       │
└─────────────────────────────────────────────────────┘

MySQL 8.0 彻底移除了 Query Cache
```

### 8.2 现代缓存方案

```
推荐方案：Redis 作为查询缓存层

┌─────────┐     ┌─────────┐     ┌──────────┐
│ 应用层   │ ──→ │  Redis  │ ──→ │  MySQL   │
│ (业务逻辑)│ ←── │ (缓存层) │ ←── │ (持久层)  │
└─────────┘     └─────────┘     └──────────┘

缓存策略：
1. Cache-Aside（旁路缓存）：
   读：先查 Redis → 命中则返回 → 未命中查 MySQL → 写入 Redis
   写：更新 MySQL → 删除 Redis 缓存

2. 缓存 Key 设计：
   key = "user:{id}"
   key = "order:list:user:{uid}:page:{page}"

3. 缓存过期时间：
   - 热点数据：TTL 5~15 分钟
   - 配置数据：TTL 1~24 小时
   - 统计报表：定时刷新 + 主动失效
```

---

## 九、双日志两阶段提交

InnoDB 同时使用 Redo Log 和 Binlog，通过两阶段提交保证两者的一致性：

```
两阶段提交流程：

1. Prepare 阶段
   InnoDB 将 Redo Log 写入磁盘
   Redo Log 标记为 prepare 状态
   记录事务 XID

2. 写 Binlog
   将事务的 Binlog 写入磁盘
   Binlog 中记录事务 XID

3. Commit 阶段
   InnoDB 将 Redo Log 标记为 commit 状态

崩溃恢复逻辑：
  ┌─────────────────────────────────────────────┐
  │ Redo Log = commit      → 事务已提交，无需处理 │
  │ Redo Log = prepare     →                      │
  │   + Binlog 完整        → 补提交（binlog 为真）│
  │   + Binlog 不完整/缺失 → 回滚事务              │
  │ Redo Log 无记录        → 事务未开始，无需处理  │
  └─────────────────────────────────────────────┘
```

```sql
-- 查看 Redo Log 配置
SHOW VARIABLES LIKE 'innodb_log%';
-- innodb_log_file_size: 单个 Redo Log 文件大小（建议 1G~4G）
-- innodb_log_files_in_group: Redo Log 文件数量（建议 2）

-- 查看 Binlog 配置
SHOW VARIABLES LIKE 'log_bin%';
SHOW VARIABLES LIKE 'binlog_format';
-- binlog_format = ROW（推荐，主从一致性最好）

-- 刷盘策略
SHOW VARIABLES LIKE 'sync_binlog';
SHOW VARIABLES LIKE 'innodb_flush_log_at_trx_commit';

-- 最安全的配置（双 1 配置）：
-- sync_binlog = 1            （每次提交刷 Binlog）
-- innodb_flush_log_at_trx_commit = 1  （每次提交刷 Redo Log）
-- 性能代价：每次事务提交都有两次磁盘刷写
```

---

## 十、核心参数调优

### 10.1 Buffer Pool 相关

```sql
-- Buffer Pool 大小：建议物理内存的 70%~80%
SET GLOBAL innodb_buffer_pool_size = 24 * 1024 * 1024 * 1024;  -- 24G (32G 服务器)

-- Buffer Pool 实例数：减少并发访问的锁竞争
-- 建议 = CPU 核心数（不超过 64）
SET GLOBAL innodb_buffer_pool_instances = 8;

-- 查看 Buffer Pool 命中率
SHOW STATUS LIKE 'Innodb_buffer_pool_read%';
-- 命中率 = (reads - read_requests) / read_requests
-- 低于 99% 说明 Buffer Pool 不够大
```

### 10.2 IO 相关参数

```sql
-- 后台 IO 线程数
SET GLOBAL innodb_read_io_threads = 8;   -- 读线程（默认 4）
SET GLOBAL innodb_write_io_threads = 8;  -- 写线程（默认 4）

-- 刷盘策略
SET GLOBAL innodb_flush_method = 'O_DIRECT';  -- 跳过 OS 缓存，避免双缓冲
-- Linux 推荐 O_DIRECT

-- 脏页刷写比例
SET GLOBAL innodb_io_capacity = 2000;         -- SSD 推荐 2000~20000
SET GLOBAL innodb_io_capacity_max = 4000;     -- SSD 推荐 4000~40000

-- 日志文件大小（影响崩溃恢复时间）
SET GLOBAL innodb_log_file_size = 2147483648;  -- 2G
-- 越大 → 写入性能越好，但崩溃恢复时间越长
```

### 10.3 连接与内存参数

```sql
-- 最大连接数
SET GLOBAL max_connections = 2000;

-- 每个连接的内存
SET GLOBAL sort_buffer_size = 262144;         -- 256KB（默认）
SET GLOBAL join_buffer_size = 262144;         -- 256KB（默认）
SET GLOBAL read_buffer_size = 131072;         -- 128KB（默认）
SET GLOBAL read_rnd_buffer_size = 262144;     -- 256KB（默认）

-- 临时表大小
SET GLOBAL tmp_table_size = 67108864;         -- 64MB
SET GLOBAL max_heap_table_size = 67108864;    -- 64MB

-- 注意：每个连接都会分配这些 buffer
-- 总内存 ≈ Buffer Pool + (max_connections × per_connection_buffers)
-- 确保总内存不超过物理内存
```

### 10.4 参数调优速查表

```
┌──────────────────────────────────────────────────────────────┐
│ 参数                        │ 推荐值           │ 说明        │
│─────────────────────────────│─────────────────│────────────│
│ innodb_buffer_pool_size     │ 物理内存 70~80%  │ 最重要参数  │
│ innodb_buffer_pool_instances│ CPU 核心数       │ 减少锁竞争  │
│ innodb_flush_log_at_trx_commit│ 1(安全)/2(性能) │ 刷盘策略   │
│ sync_binlog                 │ 1(安全)/0(性能)  │ Binlog 刷盘 │
│ innodb_log_file_size        │ 1G ~ 4G          │ 日志大小   │
│ innodb_io_capacity          │ HDD:200 SSD:2000+│ IO 能力    │
│ innodb_flush_method         │ O_DIRECT         │ 避免双缓冲 │
│ max_connections             │ 1000~5000        │ 最大连接数  │
│ innodb_file_per_table       │ ON               │ 独立表空间  │
│ binlog_format               │ ROW              │ Binlog 格式│
└──────────────────────────────────────────────────────────────┘
```

---

## 十一、研发规范

### 11.1 命名约定

```
数据库名：全小写，下划线分隔，与业务模块对应
  → order_db, user_db, payment_db

表名：全小写，下划线分隔，业务前缀
  → t_order, t_order_detail, t_user_address

列名：全小写，下划线分隔，语义明确
  → user_id, order_amount, created_at, updated_at

索引名：
  主键：pk_表名（或直接用 PRIMARY）
  唯一索引：uk_表名_列名
  普通索引：idx_表名_列名
  联合索引：idx_表名_列1_列2
```

### 11.2 表设计规范

```
强制规则：
✅ 使用 InnoDB 引擎（支持事务、行锁、MVCC）
✅ 使用 utf8mb4 字符集（支持 Emoji 和所有 Unicode）
✅ 必须有主键（推荐 BIGINT UNSIGNED AUTO_INCREMENT）
✅ 字段尽量 NOT NULL + 默认值
✅ 单表行数超过 500 万或容量超过 2G 考虑分表
✅ 禁止存储大文件（图片/文件存 OSS，数据库只存 URL）

禁止规则：
❌ 禁止使用 MyISAM（不支持事务和行锁）
❌ 禁止使用外键约束（应用层保证引用完整性）
❌ 禁止使用存储过程和触发器（业务逻辑在应用层）
❌ 禁止使用 TEXT/BLOB 作为查询条件
❌ 单表字段数不超过 50 个（过多考虑垂直拆分）
```

```sql
-- 建表模板
CREATE TABLE t_order (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
    order_no    VARCHAR(64)     NOT NULL DEFAULT ''     COMMENT '订单编号',
    user_id     BIGINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '用户ID',
    amount      DECIMAL(12,2)   NOT NULL DEFAULT 0.00   COMMENT '订单金额',
    status      TINYINT         NOT NULL DEFAULT 0      COMMENT '状态:0待支付,1已支付,2已取消',
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_order_no (order_no),
    KEY idx_user_id (user_id),
    KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单表';
```

### 11.3 索引规范

```
✅ 高频 WHERE 条件列建索引
✅ JOIN 关联列必须建索引
✅ ORDER BY / GROUP BY 列考虑纳入联合索引
✅ 单表索引数不超过 5 个
✅ 单个联合索引列数不超过 5 列
✅ 区分度低的列（如 gender）不建单列索引
✅ 长字符串使用前缀索引
✅ 定期清理未使用的索引

❌ 禁止冗余索引（idx_a 和 idx_a_b 中 idx_a 冗余）
❌ 禁止在更新频繁的列上建过多索引
❌ 禁止不建主键
```

### 11.4 SQL 开发规范

```
✅ 只 SELECT 需要的列，禁止 SELECT *
✅ INSERT 必须指定列名
✅ 使用 EXISTS 替代 IN 子查询（大数据量时）
✅ 分页查询必须带 LIMIT
✅ 批量操作使用分批处理（每批 500~1000 条）
✅ UPDATE/DELETE 必须带 WHERE 条件
✅ 使用预编译语句（PreparedStatement）防 SQL 注入

❌ 禁止在 WHERE 中对索引列使用函数
❌ 禁止不带 WHERE 的 UPDATE/DELETE
❌ 禁止 SELECT COUNT(*) 判断记录是否存在（用 LIMIT 1）
❌ 禁止在事务中做 RPC 调用或文件操作
❌ 禁止 LIKE '%xxx' 前导通配符
```

```sql
-- ❌ 反例
SELECT * FROM orders WHERE user_id IN
    (SELECT id FROM users WHERE city = 'Shanghai');

-- ✅ 优化写法
SELECT o.* FROM orders o
WHERE EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = o.user_id AND u.city = 'Shanghai'
);

-- ❌ 反例：判断记录是否存在
SELECT COUNT(*) FROM orders WHERE user_id = 100;

-- ✅ 优化写法
SELECT 1 FROM orders WHERE user_id = 100 LIMIT 1;
```

---

## 十二、面试题精选

### Q1：EXPLAIN 中 type 为 ALL 是什么意思？怎么优化？

**答**：type=ALL 表示全表扫描，是性能最差的访问方式。优化方法：（1）为 WHERE 条件中的列创建合适的索引；（2）检查是否索引失效（函数包裹、隐式类型转换等）；（3）使用联合索引覆盖查询条件。目标是至少达到 range 级别。

### Q2：MySQL 如何实现秒级统计千万级数据？

**答**：（1）预计算：用定时任务提前聚合统计结果到汇总表；（2）覆盖索引：创建包含 GROUP BY 列和聚合列的联合索引；（3）近似统计：使用 `APPROX_COUNT_DISTINCT()`（8.0+）或 HyperLogLog；（4）分区表：按时间分区，查询时只扫描相关分区；（5）读写分离 + 从库查询。

### Q3：为什么 MySQL 8.0 移除了查询缓存？

**答**：查询缓存的失效粒度是表级——任何对该表的写操作都会清除该表所有缓存条目，在读写混合的 OLTP 场景下命中率极低。同时缓存清理需要加锁，高并发下反而成为性能瓶颈。现代架构推荐使用 Redis 等外部缓存替代。

### Q4：如何优化 LIMIT 1000000, 10 这种深度分页？

**答**：（1）游标式分页：记录上一页最后一条的 ID，用 `WHERE id > last_id LIMIT 10` 替代 OFFSET；（2）延迟关联：先用覆盖索引子查询定位 ID，再 JOIN 取完整数据；（3）Elasticsearch scroll/search_after 处理搜索分页场景；（4）业务层面限制最大页码。

### Q5：JOIN 查询中驱动表和被驱动表如何选择？

**答**：原则是"小表驱动大表"。假设 A 表 1000 行，B 表 100 万行，A 驱动 B 只需 1000 次索引查找。MySQL 优化器通常能自动选择正确的驱动表，但可以通过 `EXPLAIN` 确认。使用 `STRAIGHT_JOIN` 可以强制指定驱动表（一般不需要）。

### Q6：innodb_flush_log_at_trx_commit 和 sync_binlog 如何设置？

**答**：两者配合决定数据安全级别。`innodb_flush_log_at_trx_commit=1` + `sync_binlog=1` 是"双 1 配置"，每次事务提交都刷盘，最安全但最慢。`innodb_flush_log_at_trx_commit=2` + `sync_binlog=0` 性能最好但宕机可能丢 1 秒数据。金融类业务必须双 1，普通业务可根据容忍度调整。

### Q7：生产环境如何定位慢 SQL？

**答**：（1）开启慢查询日志，设置 `long_query_time=1`；（2）使用 `pt-query-digest` 分析慢查询报告，找到 Top N 慢 SQL；（3）对慢 SQL 执行 `EXPLAIN`，分析 type、key、rows、Extra 字段；（4）常见问题：缺少索引（type=ALL）、回表过多（无覆盖索引）、大结果集排序（Using filesort）、临时表（Using temporary）；（5）优化后在测试环境用 `EXPLAIN` 验证。

### Q8：一条 SQL 执行很慢，你的排查思路是什么？

**答**：
1. 用 `SHOW PROCESSLIST` 确认是否真的慢（排除锁等待）
2. 用 `EXPLAIN` 查看执行计划，关注 type 和 key
3. 检查索引情况：`SHOW INDEX FROM table_name`
4. 检查是否有锁等待：查询 `performance_schema.data_locks`
5. 检查 Buffer Pool 命中率
6. 检查系统负载：CPU、内存、磁盘 IO
7. 检查是否大量并发写入导致 Redo Log 刷盘阻塞
8. 优化 SQL 或添加/调整索引
9. 考虑读写分离或分库分表

---

## 十三、总结

```
SQL 优化核心知识体系：

1. 架构理解：Server 层（连接器→分析器→优化器→执行器）+ 存储引擎层
2. 执行顺序：FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT
3. EXPLAIN 分析：type（const>ref>range>ALL）、key、key_len、rows、Extra
4. 慢查询诊断：慢日志 + pt-query-digest + EXPLAIN 三步法
5. JOIN 优化：小驱动大、被驱动表加索引、Hash Join
6. ORDER BY 优化：利用索引排序避免 filesort
7. 深度分页：游标式 ID、延迟关联、ES scroll
8. 参数调优：Buffer Pool(70-80%)、双 1 配置、IO 线程
9. 研发规范：InnoDB + utf8mb4、命名约定、索引规则、SQL 标准
```

> 至此，MySQL 核心三篇完结：索引篇、事务锁篇、SQL 优化篇。三篇合计覆盖了 MySQL 面试与实战的核心知识点，建议反复研读并动手实践。
