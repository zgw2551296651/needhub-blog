# MySQL 索引深度解析——B+Tree、索引类型与优化实战

> 索引是 MySQL 性能优化的核心武器。本文将从 B+Tree 底层结构出发，逐层剖析索引分类、联合索引原理、索引失效场景，最终给出生产级索引设计最佳实践。全文约 8000 字，建议收藏后反复研读。

---

## 一、为什么需要索引？

想象你在一个拥有 1000 万行记录的 `users` 表中查找 `email = 'tom@example.com'` 的用户。没有索引时，MySQL 必须从头到尾逐行扫描——这就是**全表扫描（Full Table Scan）**，在大数据量下性能灾难性下降。

```sql
-- 无索引：全表扫描，1000万行逐行比对
SELECT * FROM users WHERE email = 'tom@example.com';
-- 耗时：2.3s

-- 有索引：B+Tree 3 层定位，毫秒级响应
CREATE INDEX idx_email ON users(email);
SELECT * FROM users WHERE email = 'tom@example.com';
-- 耗时：0.001s
```

索引本质上是一种**排好序的数据结构**，让数据库能以 O(log N) 而非 O(N) 的时间复杂度定位数据。

---

## 二、B+Tree 底层结构

### 2.1 为什么不用其他数据结构？

| 数据结构 | 查找复杂度 | 是否有序 | 磁盘友好 | 范围查询 | 结论 |
|---------|-----------|---------|---------|---------|------|
| Hash 表 | O(1) | 否 | 差 | 不支持 | 只适合等值查询，不适合范围 |
| BST（二叉搜索树） | O(log N) ~ O(N) | 是 | 极差 | 支持 | 可能退化为链表 |
| AVL 树 | O(log N) | 是 | 差 | 支持 | 树高太高，磁盘IO多 |
| 红黑树 | O(log N) | 是 | 差 | 支持 | 同样树高问题，MySQL未采用 |
| B-Tree | O(log N) | 是 | 好 | 支持 | 非叶子也存数据，扇出低 |
| **B+Tree** | **O(log N)** | **是** | **极好** | **极好** | **MySQL InnoDB 最终选择** |

**核心问题：为什么不用红黑树？**

红黑树是二叉树，每个节点只有 2 个子节点。1000 万条数据需要树高约 23 层，每层一次磁盘 IO，就是 23 次 IO。而 B+Tree 是多叉树，每个节点可以有上千个子节点，同样 1000 万数据只需 3-4 层。

### 2.2 B+Tree 的五大核心特性

```
                    [非叶子节点]
                   /     |     \
           [非叶子]   [非叶子]   [非叶子]
           / | \      / | \      / | \
         [L1]-[L2]-[L3]-[L4]-[L5]-[L6]-[L7]-[L8]-[L9]
          ↕    ↕    ↕    ↕    ↕    ↕    ↕    ↕    ↕
        (叶子节点通过双向链表互相连接)
```

**特性一：数据全部存储在叶子节点**

非叶子节点只存储键值用于导航，不存数据行。这保证了每个非叶子节点能容纳更多键值，最大化扇出（fan-out），降低树高。

**特性二：叶子节点通过双向链表连接**

所有叶子节点形成一条有序的双向链表，范围查询只需定位起点后沿链表顺序扫描，无需回溯父节点。

```sql
-- 范围查询示例：只需找到 id=100，然后沿链表向后扫描到 id=200
SELECT * FROM users WHERE id BETWEEN 100 AND 200;
```

**特性三：多叉树（矮胖结构）**

InnoDB 每个页默认 16KB，假设主键为 BIGINT（8字节），指针占 6 字节：

```
每个非叶子节点可容纳的键值数 = 16KB / (8B + 6B) ≈ 1170
```

这意味着：
- 1 层：1170 个键
- 2 层：1170 x 1170 ≈ 137 万个键
- 3 层：1170 x 1170 x 1170 ≈ **16 亿个键**

所以 1000 万行数据的表，B+Tree 只需要 **3 层**，即最多 3 次磁盘 IO。

**特性四：磁盘页对齐**

B+Tree 的每个节点对应一个磁盘页（16KB），一次 IO 读入一个完整节点，最大化每次 IO 的利用率。

**特性五：顺序访问友好**

叶子节点链表天然有序，排序查询 `ORDER BY` 和分组查询 `GROUP BY` 可以直接利用索引的有序性，避免额外的排序操作。

### 2.3 InnoDB 页结构与 Buffer Pool

InnoDB 将数据文件划分为固定大小的**页（Page）**，默认 16KB：

```
┌──────────────────────────────────────────┐
│            InnoDB 数据文件                 │
├─────────┬─────────┬─────────┬───────────┤
│ Page 0  │ Page 1  │ Page 2  │ Page ...  │
│ (16KB)  │ (16KB)  │ (16KB)  │  (16KB)   │
└─────────┴─────────┴─────────┴───────────┘

单个页的内部结构：
┌──────────────────────────────────────┐
│  File Header (38B) - 页号/LSN/校验    │
│  Page Header (56B) - 记录数/空间信息   │
│  Records (变长) - 实际数据行           │
│  Free Space - 空闲空间                │
│  Page Directory (槽) - 记录的二分索引  │
│  File Trailer (8B) - 写入完整性校验    │
└──────────────────────────────────────┘
```

**Buffer Pool** 是 InnoDB 的内存缓存区，用于缓存热点数据页：

```
磁盘文件                    Buffer Pool (内存)
┌─────┐                  ┌─────────────────┐
│Page │ ────── 读取 ───→ │ Cached Page     │
│  A  │ ←──── 写回 ───── │ (16KB aligned)  │
└─────┘                  ├─────────────────┤
┌─────┐                  │ Cached Page     │
│Page │ ────── 读取 ───→ │ (LRU List管理)  │
│  B  │                  └─────────────────┘
└─────┘

Buffer Pool 使用改进的 LRU 算法：
  - 将 LRU 链表分为 young 区和 old 区
  - 新读入的页放在 old 区头部（约 37% 位置）
  - 只有在 old 区存活超过 1 秒后才晋升到 young 区
  - 防止全表扫描冲刷掉热点数据
```

```sql
-- 查看 Buffer Pool 状态
SHOW STATUS LIKE 'Innodb_buffer_pool%';

-- 关键参数：
-- innodb_buffer_pool_size：建议设为物理内存的 70%~80%
-- innodb_buffer_pool_instances：多实例减少锁竞争
```

---

## 三、索引分类全景图

### 3.1 按数据结构分类

| 索引类型 | 底层结构 | 适用场景 | InnoDB 支持 |
|---------|---------|---------|-------------|
| B+Tree 索引 | B+Tree | 等值、范围、排序 | 默认，全面支持 |
| Hash 索引 | 哈希表 | 仅等值查询 | 自适应哈希（内部自动） |
| 全文索引 | 倒排表 | 文本全文搜索 | 5.6+ 支持 |
| R-Tree 索引 | R-Tree | 空间数据(GIS) | 支持 |

**自适应哈希索引（Adaptive Hash Index）**：InnoDB 内部自动为热点等值查询建立 Hash 索引，无需人工干预：

```sql
-- 查看自适应哈希状态
SHOW VARIABLES LIKE 'innodb_adaptive_hash_index';
-- 默认开启，对于大量等值查询能显著提升性能
```

### 3.2 按存储方式分类

**聚簇索引（Clustered Index）**：
- 索引的叶子节点直接存储整行数据
- InnoDB 每张表有且仅有一个聚簇索引
- 数据行的物理存储顺序与聚簇索引一致

**非聚簇索引（Secondary Index）**：
- 叶子节点存储的是主键值，而非整行数据
- 通过非聚簇索引查找数据时需要"回表"

### 3.3 按业务用途分类

```sql
-- 1. 主键索引：唯一 + 非空
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(50)
);

-- 2. 唯一索引：值唯一，允许 NULL
CREATE UNIQUE INDEX idx_email ON users(email);

-- 3. 普通索引：最基本索引，无限制
CREATE INDEX idx_name ON users(name);

-- 4. 前缀索引：取列值的前 N 个字符
CREATE INDEX idx_email_prefix ON users(email(10));

-- 5. 联合索引：多列组合
CREATE INDEX idx_age_city ON users(age, city);
```

**前缀索引的选择方法**：

```sql
-- 第一步：查看完整列的区分度
SELECT COUNT(DISTINCT email) / COUNT(*) AS full_selectivity FROM users;

-- 第二步：测试不同前缀长度的区分度
SELECT COUNT(DISTINCT LEFT(email, 5)) / COUNT(*) AS sel_5 FROM users;
SELECT COUNT(DISTINCT LEFT(email, 6)) / COUNT(*) AS sel_6 FROM users;
SELECT COUNT(DISTINCT LEFT(email, 7)) / COUNT(*) AS sel_7 FROM users;
SELECT COUNT(DISTINCT LEFT(email, 8)) / COUNT(*) AS sel_8 FROM users;

-- 选择区分度达到完整列 90% 以上的最短前缀长度
-- 前缀索引不能用于 ORDER BY 和 GROUP BY
-- 前缀索引不能用作覆盖索引
```

---

## 四、聚簇索引 vs 非聚簇索引

### 4.1 聚簇索引详解

```
聚簇索引（主键索引）的 B+Tree 结构：
           [非叶子: 30, 60]
           /        \
      [非叶子:30]  [非叶子:60]
       /    \        /    \
  ┌────────┐┌────────┐┌────────┐┌────────┐
  │10│整行 ││30│整行 ││60│整行 ││90│整行 │
  │20│整行 ││40│整行 ││70│整行 ││100│整行│
  └────────┘└────────┘└────────┘└────────┘
     叶子节点存储完整的数据行
```

**InnoDB 聚簇索引的主键选择规则**：
1. 显式定义的 `PRIMARY KEY`
2. 第一个 `NOT NULL` 的 `UNIQUE` 索引
3. InnoDB 自动生成隐藏的 6 字节 `ROW_ID`

**ROW_ID 的隐患**：
```sql
-- 没有主键的表，InnoDB 自动生成 ROW_ID
CREATE TABLE logs (
    message TEXT,
    created_at DATETIME
    -- 没有主键！
);

-- 问题：
-- 1. ROW_ID 是全局递增的，多表共享，可能产生竞争
-- 2. ROW_ID 不持久化在 SQL 层，重建表后值会变
-- 3. 无法通过 ROW_ID 进行精确查询
-- 建议：所有表都必须显式定义主键！
```

### 4.2 非聚簇索引与回表

```
非聚簇索引（二级索引）的 B+Tree 结构：
           [非叶子: Jack, Tom]
           /              \
  ┌──────────────┐  ┌──────────────┐
  │Bob  → PK=3   │  │Mike → PK=7   │
  │Jack → PK=1   │  │Tom  → PK=5   │
  └──────────────┘  └──────────────┘
  叶子节点存储的是主键值

查找过程（回表）：
1. 在非聚簇索引中定位 name='Tom' → 得到 PK=5
2. 在聚簇索引中查找 PK=5 → 得到完整行数据
```

```sql
-- 回表示例
CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    user_id BIGINT,
    amount DECIMAL(10,2),
    status TINYINT,
    INDEX idx_user_id (user_id)
);

-- 这条 SQL 需要回表：
-- 先在 idx_user_id 找到主键 id，再去聚簇索引取整行
SELECT * FROM orders WHERE user_id = 100;

-- 这条 SQL 不需要回表（覆盖索引）：
-- user_id 和 id 都在 idx_user_id 的叶子节点中
SELECT user_id, id FROM orders WHERE user_id = 100;
```

---

## 五、联合索引深度剖析

### 5.1 最左前缀匹配规则

联合索引 `(a, b, c)` 在 B+Tree 中的排序方式：

```
B+Tree 中联合索引 (a, b, c) 的排序逻辑：
先按 a 排序 → a 相同按 b 排序 → b 相同按 c 排序

叶子节点顺序示例：
(1, 'x', 100) → (1, 'x', 200) → (1, 'y', 100) →
(2, 'x', 100) → (2, 'y', 300) → (3, 'x', 100)
```

**最左前缀匹配规则**：查询条件必须从联合索引的最左列开始，不能跳过中间列。

```sql
CREATE INDEX idx_abc ON users(a, b, c);

-- ✅ 走索引的情况：
WHERE a = 1                       -- 使用 a
WHERE a = 1 AND b = 2             -- 使用 a, b
WHERE a = 1 AND b = 2 AND c = 3   -- 使用 a, b, c
WHERE a = 1 AND c = 3             -- 使用 a（b 被跳过，c 无法使用索引匹配）

-- ❌ 不走索引的情况：
WHERE b = 2                       -- 缺少最左列 a
WHERE c = 3                       -- 缺少最左列 a
WHERE b = 2 AND c = 3             -- 缺少最左列 a
```

### 5.2 范围查询对联合索引的影响

```sql
-- 索引 (a, b, c)
-- 范围查询列之后的列无法使用索引进行匹配

WHERE a = 1 AND b > 10 AND c = 3
-- a: 等值匹配 ✅ 使用索引
-- b: 范围匹配 ✅ 使用索引
-- c: 等值匹配 ❌ 无法使用索引（b 是范围查询，c 无法利用有序性）

-- 优化方案：将等值查询列放在范围查询列之前
-- 索引改为 (a, c, b)
WHERE a = 1 AND c = 3 AND b > 10
-- a: ✅  c: ✅  b: ✅  全部走索引
```

### 5.3 Skip Scan Index（MySQL 8.0.13+）

MySQL 8.0.13 引入了 Skip Scan 优化，当联合索引首列区分度较低时，即使查询条件不包含首列也可能使用索引：

```sql
-- 假设 gender 只有 'M' 和 'F' 两个值
CREATE INDEX idx_gender_age ON users(gender, age);

-- MySQL 8.0.13 之前：不走索引（缺少最左列 gender）
SELECT * FROM users WHERE age = 25;

-- MySQL 8.0.13 之后：可能走 Skip Scan
-- 优化器将查询拆分为：
--   gender='F' AND age=25  (使用索引)
--   UNION
--   gender='M' AND age=25  (使用索引)
-- Skip Scan 生效条件：首列区分度低（不同值少）
```

### 5.4 覆盖索引（Covering Index）

当查询所需的所有列都在索引中时，无需回表，称为覆盖索引：

```sql
CREATE INDEX idx_name_age ON users(name, age);

-- 覆盖索引：EXPLAIN 中 Extra 显示 "Using index"
SELECT name, age FROM users WHERE name = 'Tom';
-- name 和 age 都在 idx_name_age 索引中，无需回表

-- 非覆盖索引：需要回表取 id 等其他列
SELECT * FROM users WHERE name = 'Tom';

-- 覆盖索引优化技巧：
-- 对于高频查询，创建包含所有查询列的联合索引
-- 但要注意：索引太宽会增加写入开销和存储空间
```

### 5.5 索引条件下推（ICP）

ICP（Index Condition Pushdown）将索引能过滤的条件推送到存储引擎层，减少回表次数：

```sql
CREATE INDEX idx_name ON users(name);

-- ICP 优化示例：
-- MySQL 5.6 之前：先通过索引取出所有匹配 name 的行，全部回表，再过滤 age
SELECT * FROM users WHERE name LIKE 'Tom%' AND age > 30;

-- MySQL 5.6+ ICP：
-- 1. 在索引层过滤 name LIKE 'Tom%'
-- 2. 对索引匹配的行，先检查 age > 30 再回表
-- EXPLAIN Extra 显示 "Using index condition"
```

---

## 六、索引失效的 9 种场景

### 6.1 对索引列进行数学运算

```sql
-- ❌ 索引失效
SELECT * FROM orders WHERE id + 1 = 100;

-- ✅ 改写为
SELECT * FROM orders WHERE id = 100 - 1;
```

### 6.2 对索引列使用函数

```sql
-- ❌ 索引失效
SELECT * FROM users WHERE YEAR(created_at) = 2024;
SELECT * FROM users WHERE LEFT(name, 3) = 'Tom';

-- ✅ 改写为范围查询
SELECT * FROM users
WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';

SELECT * FROM users WHERE name LIKE 'Tom%';
```

### 6.3 隐式类型转换

```sql
-- phone 列是 VARCHAR 类型
-- ❌ 索引失效：MySQL 将 VARCHAR 隐式转换为 INT 进行比较
SELECT * FROM users WHERE phone = 13800138000;

-- ✅ 使用字符串
SELECT * FROM users WHERE phone = '13800138000';

-- 常见隐式转换陷阱：
-- VARCHAR 列用数字查询 → 失效
-- INT 列用字符串查询 → 不影响（MySQL 会转换字符串为数字）
```

### 6.4 前导通配符

```sql
-- ❌ 索引失效：前导 % 无法利用 B+Tree 有序性
SELECT * FROM users WHERE name LIKE '%Tom';

-- ✅ 后缀通配符可以使用索引
SELECT * FROM users WHERE name LIKE 'Tom%';

-- 解决方案：使用全文索引
ALTER TABLE users ADD FULLTEXT INDEX ft_name(name);
SELECT * FROM users WHERE MATCH(name) AGAINST('Tom' IN BOOLEAN MODE);
```

### 6.5 OR 逻辑导致索引失效

```sql
-- 假设只有 idx_name，没有 idx_age
-- ❌ OR 导致全表扫描
SELECT * FROM users WHERE name = 'Tom' OR age = 25;

-- ✅ 方案一：为两列都建索引，MySQL 可能使用 Index Merge
CREATE INDEX idx_age ON users(age);

-- ✅ 方案二：改写为 UNION
SELECT * FROM users WHERE name = 'Tom'
UNION
SELECT * FROM users WHERE age = 25;
```

### 6.6 不等于（!= 或 <>）

```sql
-- ⚠️ 不等于通常导致索引失效，走全表扫描
SELECT * FROM users WHERE status != 0;

-- 优化：如果 status=0 占大多数，可以改为
SELECT * FROM users WHERE status IN (1, 2, 3);
```

### 6.7 IS NULL / IS NOT NULL

```sql
-- ⚠️ 在某些情况下 IS NULL 可能导致索引失效
-- 取决于数据分布和优化器选择
SELECT * FROM users WHERE email IS NULL;

-- 最佳实践：字段设置 NOT NULL + 默认值
ALTER TABLE users MODIFY email VARCHAR(255) NOT NULL DEFAULT '';
```

### 6.8 超大 IN 列表

```sql
-- ❌ IN 列表过大时优化器可能放弃索引
SELECT * FROM users WHERE id IN (1, 2, 3, ..., 10000);

-- ✅ 方案一：分批查询
SELECT * FROM users WHERE id IN (1, 2, ..., 500);
SELECT * FROM users WHERE id IN (501, 502, ..., 1000);

-- ✅ 方案二：使用临时表 + JOIN
CREATE TEMPORARY TABLE tmp_ids (id BIGINT PRIMARY KEY);
INSERT INTO tmp_ids VALUES (1), (2), ...;
SELECT u.* FROM users u INNER JOIN tmp_ids t ON u.id = t.id;
```

### 6.9 排序与过滤列不匹配

```sql
-- 索引 idx_status (status)
-- ❌ 排序列与过滤列不在同一索引中，导致 filesort
SELECT * FROM users WHERE status = 1 ORDER BY created_at;

-- ✅ 创建联合索引同时覆盖过滤和排序
CREATE INDEX idx_status_created ON users(status, created_at);
-- 这样 WHERE 和 ORDER BY 都能使用索引
```

---

## 七、索引设计最佳实践

### 7.1 基数与选择性

**选择性（Selectivity）**= 不同值数量 / 总行数。选择性越接近 1，索引效果越好。

```sql
-- 计算列的选择性
SELECT
    COUNT(DISTINCT column_name) / COUNT(*) AS selectivity
FROM table_name;

-- 经验法则：
-- 选择性 > 0.8 → 适合建索引
-- 选择性 < 0.1 → 索引效果差，考虑不建
-- 例如：gender 列只有 M/F，选择性约 0.5，单列索引效果一般
-- 例如：email 列几乎唯一，选择性接近 1，非常适合建索引
```

### 7.2 索引数量控制

```
每个索引的代价：
┌─────────────────────────────────────────────────┐
│ 写入代价：INSERT/UPDATE/DELETE 都要维护索引      │
│ 空间代价：每个索引占用额外磁盘和内存空间          │
│ 优化器代价：索引越多，优化器选择路径越复杂         │
└─────────────────────────────────────────────────┘

建议：
- 单表索引数量不超过 5 个
- 单个联合索引列数不超过 5 列
- 高写入表严格控制索引数量
- 定期审查未使用的索引并删除
```

```sql
-- 查找未使用的索引（MySQL 8.0+ Performance Schema）
SELECT * FROM sys.schema_unused_indexes;

-- 查找重复索引
SELECT * FROM sys.schema_redundant_indexes;

-- 删除无用索引
DROP INDEX idx_old ON users;
```

### 7.3 索引设计检查清单

```
✅ 所有表都有显式主键（推荐自增 BIGINT）
✅ WHERE 条件高频列已建索引
✅ JOIN 关联列已建索引
✅ ORDER BY / GROUP BY 列考虑纳入联合索引
✅ 使用联合索引替代多个单列索引
✅ 字符串列使用前缀索引节省空间
✅ 避免在低选择性列上建独立索引
✅ 覆盖索引用于高频查询场景
✅ 定期审查和清理冗余索引
✅ 索引列避免 NULL，使用 NOT NULL + 默认值
```

---

## 八、索引操作的 DDL 注意事项

```sql
-- 在线加索引（MySQL 5.6+ Online DDL）
ALTER TABLE users ADD INDEX idx_email(email), ALGORITHM=INPLACE, LOCK=NONE;

-- 查看索引信息
SHOW INDEX FROM users;

-- 使用 EXPLAIN 验证索引使用情况
EXPLAIN SELECT * FROM users WHERE email = 'tom@example.com'\G

-- 强制使用某个索引
SELECT * FROM users FORCE INDEX(idx_email) WHERE email = 'tom@example.com';

-- 忽略某个索引
SELECT * FROM users IGNORE INDEX(idx_email) WHERE email = 'tom@example.com';
```

---

## 九、面试题精选

### Q1：为什么 InnoDB 使用 B+Tree 而不是 B-Tree？

**答**：B-Tree 的非叶子节点也存储数据行，导致每个节点能存储的键值数量减少，树更高，IO 次数更多。B+Tree 非叶子节点只存键值，扇出更大，树更矮（通常 3 层即可支撑千万级数据）。此外 B+Tree 叶子节点通过链表连接，范围查询只需顺序扫描链表，而 B-Tree 范围查询需要中序遍历整棵树。

### Q2：什么是回表？如何避免？

**答**：通过二级索引查到主键后，需要再去聚簇索引获取完整行数据，这个过程叫回表。避免方法：使用**覆盖索引**，即创建包含查询所需所有列的联合索引，使 EXPLAIN Extra 显示 "Using index"。

### Q3：联合索引 (a, b, c)，`WHERE a=1 AND c=3` 能用索引吗？

**答**：只能用到 a 列的索引。b 列被跳过，c 列无法利用索引的有序性进行匹配。但在 MySQL 8.0+ 中，c 列可能通过 ICP（索引条件下推）在存储引擎层进行过滤。

### Q4：一张表最多能建多少索引？

**答**：InnoDB 限制单表最多 64 个二级索引。但从性能角度，建议不超过 5 个。过多索引会显著增加写入开销（每次 INSERT/UPDATE/DELETE 都要同步维护所有索引的 B+Tree），并增加优化器选择执行计划的时间。

### Q5：`ORDER BY id` 会使用索引吗？

**答**：如果 WHERE 条件能使用某个索引，且 ORDER BY 的列是该索引的一部分或主键，通常可以使用索引排序（Using index）。否则需要 filesort（额外排序）。联合索引中，ORDER BY 列必须在等值条件之后才能利用索引排序。

### Q6：主键用自增 ID 还是 UUID？

**答**：强烈推荐自增 ID。UUID 是 36 字节字符串，作为聚簇索引会导致：（1）插入时频繁页分裂（UUID 无序）；（2）索引空间膨胀（UUID 比 BIGINT 大 4.5 倍）；（3）所有二级索引都会更大（存储的是主键值）。如果业务需要全局唯一 ID，可以使用雪花算法（Snowflake）生成的有序 BIGINT。

### Q7：索引越多查询越快吗？

**答**：不是。索引对读操作加速，但对写操作是负担。每个索引在 INSERT/UPDATE/DELETE 时都需要额外维护 B+Tree 结构。此外，过多索引会占用大量 Buffer Pool 空间，反而降低缓存命中率。应根据实际查询模式精心设计，而非无脑堆砌。

---

## 十、总结

```
MySQL 索引核心知识体系：

1. 底层结构：B+Tree（矮胖、叶子链表、数据在叶子）
2. 聚簇索引：一张表只有一个，叶子存整行数据
3. 非聚簇索引：叶子存主键，可能需要回表
4. 联合索引：最左前缀匹配，等值在前范围在后
5. 覆盖索引：查询列全在索引中，无需回表
6. 索引失效：函数/运算/隐式转换/前导%/OR 等 9 种场景
7. 设计原则：选择性>0.8、数量<5、定期清理冗余索引
```

> 下一篇预告：《MySQL 事务与锁机制——ACID、MVCC 与死锁防治》，深入解析 InnoDB 的事务实现与锁机制。
