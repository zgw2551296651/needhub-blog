# MyBatis 核心原理与实战——从 MapperProxy 到缓存机制

> 本文深入剖析 MyBatis 框架的核心原理，从底层代理机制到缓存体系，从动态 SQL 到插件拦截，配合大量源码分析与生产实战经验，帮助你真正理解 MyBatis 的设计哲学。适用于中高级 Java 开发者系统性进阶。

---

## 一、ORM 框架对比：MyBatis vs Hibernate

### 1.1 两种 ORM 哲学

在 Java 持久层领域，长期存在两大阵营：**全自动 ORM** 与 **半自动 ORM**。

| 维度 | Hibernate（全自动） | MyBatis（半自动） |
|------|---------------------|-------------------|
| SQL 控制权 | 框架自动生成 | 开发者手写 SQL |
| 学习曲线 | 陡峭（HQL、缓存、脏检查） | 平缓（SQL 即所得） |
| 复杂查询 | 多表关联映射困难 | 灵活编写任意 SQL |
| 数据库迁移 | 依赖 Dialect 抽象 | SQL 需手动调整 |
| 性能调优 | 黑盒，难以精确控制 | 白盒，SQL 级优化 |
| 适用场景 | CRUD 密集、标准化业务 | 高并发、复杂报表、读写分离 |

### 1.2 为什么高并发场景 MyBatis 更优？

在互联网高并发场景下，MyBatis 的优势体现在三个层面：

**第一，SQL 精确控制。** 开发者可以直接针对索引、执行计划进行优化，避免 Hibernate 自动生成的低效 SQL。比如对于覆盖索引的利用：

```sql
-- MyBatis 直接写覆盖索引查询，避免回表
SELECT id, user_name, email 
FROM t_user 
WHERE status = 1 AND create_time > #{startTime}
```

**第二，连接池利用率高。** MyBatis 的 SqlSession 生命周期短、无状态，配合 Druid/HikariCP 可以最大化连接利用率。而 Hibernate 的 Session 与一级缓存强绑定，长 Session 容易导致内存膨胀。

**第三，批量操作性能。** MyBatis 的 BatchExecutor 支持 JDBC 原生批量操作，吞吐量远超 Hibernate 的逐条 flush：

```xml
<insert id="batchInsertUsers">
    INSERT INTO t_user (user_name, email, status)
    VALUES
    <foreach collection="users" item="user" separator=",">
        (#{user.userName}, #{user.email}, #{user.status})
    </foreach>
</insert>
```

---

## 二、MyBatis 工作原理：从 MapperProxy 到 SQL 执行

### 2.1 MapperProxy——JDK 动态代理的精妙运用

当你调用 `userMapper.selectById(1)` 时，背后发生了什么？答案藏在 `MapperProxy` 中。

MyBatis 为每个 Mapper 接口创建 JDK 动态代理对象，核心流程如下：

```
+--------------------+     +------------------+     +------------------+
| UserMapper 接口     | --> | MapperProxy      | --> | MapperMethod     |
| (开发者定义)        |     | (JDK 动态代理)    |     | (SQL 分发器)      |
+--------------------+     +------------------+     +------------------+
                                    |                        |
                                    v                        v
                           InvocationHandler         SqlCommandType
                           invoke() 方法拦截          INSERT/SELECT/
                                                      UPDATE/DELETE
```

核心源码分析（简化版）：

```java
public class MapperProxy<T> implements InvocationHandler, Serializable {
    private final SqlSession sqlSession;
    private final Class<T> mapperInterface;
    // 方法缓存，避免重复反射
    private final Map<Method, MapperMethodInvoker> methodCache;

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        // 1. Object 类方法直接执行（toString、hashCode 等）
        if (Object.class.equals(method.getDeclaringClass())) {
            return method.invoke(this, args);
        }
        // 2. 接口默认方法（Java 8 default method）
        if (method.isDefault()) {
            return invokeDefaultMethod(proxy, method, args);
        }
        // 3. 通过 MapperMethod 执行 SQL
        MapperMethod mapperMethod = cachedMapperMethod(method);
        return mapperMethod.execute(sqlSession, args);
    }
}
```

### 2.2 MapperMethod——SQL 类型分发器

`MapperMethod` 根据 SQL 类型（INSERT/SELECT/UPDATE/DELETE）将调用分发到 `SqlSession` 的不同方法：

```java
public class MapperMethod {
    private final SqlCommand command;  // 包含 SQL 类型和 ID
    private final MethodSignature method;  // 方法签名信息

    public Object execute(SqlSession sqlSession, Object[] args) {
        Object result;
        switch (command.getType()) {
            case INSERT:
                result = sqlSession.insert(command.getName(), param);
                break;
            case UPDATE:
                result = sqlSession.update(command.getName(), param);
                break;
            case DELETE:
                result = sqlSession.delete(command.getName(), param);
                break;
            case SELECT:
                if (method.returnsVoid() && method.hasResultHandler()) {
                    sqlSession.select(command.getName(), param, resultHandler);
                    result = null;
                } else if (method.returnsMany()) {
                    result = sqlSession.selectList(command.getName(), param);
                } else {
                    result = sqlSession.selectOne(command.getName(), param);
                }
                break;
            default:
                throw new BindingException("Unknown execution type");
        }
        return result;
    }
}
```

### 2.3 完整执行链路

```
Mapper接口调用
    |
    v
MapperProxy.invoke()
    |
    v
MapperMethod.execute()
    |
    v
SqlSession.selectOne/insert/update/delete
    |
    v
Executor.query/update（一级缓存检查）
    |
    v
StatementHandler.prepare（创建 PreparedStatement）
    |
    v
ParameterHandler.setParameters（参数绑定）
    |
    v
ResultSetHandler.handleResultSets（结果映射）
```

---

## 三、三种 Executor 详解

MyBatis 提供了三种 Executor 实现，通过 `ExecutorType` 枚举选择：

### 3.1 SimpleExecutor——简单执行器（默认）

每次执行 SQL 都会创建新的 `Statement` 对象，执行完毕立即关闭。实现简单，适合大多数场景。

```java
public class SimpleExecutor extends BaseExecutor {
    @Override
    public int doUpdate(MappedStatement ms, Object parameter) {
        Statement stmt = null;
        try {
            Configuration configuration = ms.getConfiguration();
            StatementHandler handler = configuration.newStatementHandler(this, ms, parameter, ...);
            stmt = prepareStatement(handler, ms.getStatementLog());
            return handler.update(stmt);
        } finally {
            closeStatement(stmt);  // 每次都关闭
        }
    }
}
```

### 3.2 ReuseExecutor——语句复用执行器

以 SQL 文本为 key 缓存 `Statement` 对象，同一个 SqlSession 内相同 SQL 不会重复创建 Statement。

```java
public class ReuseExecutor extends BaseExecutor {
    // SQL -> Statement 缓存
    private final Map<String, Statement> statementMap = new HashMap<>();

    @Override
    public int doUpdate(MappedStatement ms, Object parameter) {
        StatementHandler handler = configuration.newStatementHandler(this, ms, parameter, ...);
        Statement stmt = prepareStatement(handler, ms.getStatementLog());
        // 注意：不关闭 Statement，放入缓存
        return handler.update(stmt);
    }

    private Statement prepareStatement(StatementHandler handler, Log statementLog) {
        String sql = handler.getBoundSql().getSql();
        if (hasStatementFor(sql)) {
            // 命中缓存，复用 Statement
            return getStatement(sql);
        }
        // 未命中，创建新 Statement 并缓存
        Statement stmt = handler.prepare(connection, transaction.getTimeout());
        putStatement(sql, stmt);
        return stmt;
    }
}
```

### 3.3 BatchExecutor——批量执行器

将多条 SQL 打包为一次 JDBC 批量操作，大幅提升批量写入性能：

```java
public class BatchExecutor extends BaseExecutor {
    private final List<BatchResult> batchResultList = new ArrayList<>();

    @Override
    public int doUpdate(MappedStatement ms, Object parameterObject) {
        String sql = ms.getBoundSql(parameterObject).getSql();
        // 判断是否与上一条 SQL 相同
        if (sql.equals(currentSql)) {
            // 相同：addBatch
            handler.parameterize(stmt);
            BatchResult batchResult = batchResultList.get(batchResultList.size() - 1);
            batchResult.addParameterObject(parameterObject);
            stmt.addBatch();
        } else {
            // 不同：创建新 Statement
            Statement stmt = handler.prepare(connection, transaction.getTimeout());
            stmt.addBatch();
            currentSql = sql;
        }
        return BATCH_UPDATE_RETURN_VALUE;
    }

    // 统一刷盘
    @Override
    public List<BatchResult> doFlushStatements(boolean isRollback) {
        for (BatchResult batchResult : batchResultList) {
            Statement stmt = batchResult.getStatement();
            batchResult.setUpdateCounts(stmt.executeBatch());
        }
        return batchResultList;
    }
}
```

### 3.4 三种 Executor 使用方式

```java
// 默认 SimpleExecutor
SqlSession session = sqlSessionFactory.openSession();

// ReuseExecutor
SqlSession session = sqlSessionFactory.openSession(ExecutorType.REUSE);

// BatchExecutor（批量插入场景）
SqlSession session = sqlSessionFactory.openSession(ExecutorType.BATCH);
try {
    UserMapper mapper = session.getMapper(UserMapper.class);
    for (int i = 0; i < 10000; i++) {
        mapper.insert(new User("user" + i));
    }
    session.commit();  // 触发 executeBatch
} finally {
    session.close();
}
```

---

## 四、缓存机制：一级缓存与二级缓存

### 4.1 一级缓存（Local Cache）

一级缓存是 `SqlSession` 级别的缓存，**默认开启**，底层使用 `PerpetualCache`（HashMap 实现）。

```
SqlSession
    |
    +-- Executor
            |
            +-- localCache (PerpetualCache)
                    |
                    +-- HashMap<CacheKey, Object>
```

**缓存键的构成：**

```java
public class CacheKey implements Cloneable, Serializable {
    // hash 值由以下字段计算
    private int count;
    private long checksum;
    private int hash;
    private List<Object> updateList;  // 存储以下字段

    // CacheKey 构成：
    // 1. MappedStatement ID（如 com.example.mapper.UserMapper.selectById）
    // 2. 分页参数 offset + limit
    // 3. 完整 SQL 语句（含参数值）
    // 4. 参数值列表
    // 5. Environment ID（数据源标识）
}
```

**一级缓存失效的四种情况：**

1. **不同的 SqlSession**——不同会话有独立的一级缓存
2. **同一个 SqlSession，不同的查询参数**——CacheKey 不同
3. **执行了增删改操作**——`update/insert/delete` 会调用 `clearLocalCache()`
4. **手动调用 `sqlSession.clearCache()`**

```java
// 源码中的缓存清理时机
public int update(MappedStatement ms, Object parameter) {
    clearLocalCache();  // 增删改自动清理一级缓存
    return doUpdate(ms, parameter);
}
```

### 4.2 二级缓存（Global Cache）

二级缓存是 **namespace（Mapper 接口）级别**的缓存，需要**手动开启**。

**开启步骤：**

```xml
<!-- 步骤1：在 mybatis-config.xml 中启用全局缓存 -->
<settings>
    <setting name="cacheEnabled" value="true"/>
</settings>

<!-- 步骤2：在 Mapper XML 中添加 cache 标签 -->
<mapper namespace="com.example.mapper.UserMapper">
    <cache
        eviction="LRU"          <!-- 淘汰策略：LRU/FIFO/SOFT/WEAK -->
        flushInterval="60000"   <!-- 刷新间隔（毫秒），0表示不自动刷新 -->
        size="1024"              <!-- 最大缓存条目数 -->
        readOnly="true"          <!-- 是否只读 -->
        blocking="false"         <!-- 缓存未命中时是否阻塞等待 -->
    />
</mapper>
```

**四种淘汰策略：**

| 策略 | 实现类 | 原理 | 适用场景 |
|------|--------|------|---------|
| LRU | LruCache | LinkedHashMap + accessOrder | 通用（默认推荐） |
| FIFO | FifoCache | LinkedList 队列 | 访问频率均匀场景 |
| SOFT | SoftCache | SoftReference 软引用 | 内存敏感场景 |
| WEAK | WeakCache | WeakReference 弱引用 | GC 即回收 |

**二级缓存的工作原理：**

```
查询请求
    |
    v
CachingExecutor（装饰器模式）
    |
    +-- 检查二级缓存（TransactionalCacheManager）
            |
            +-- 命中 -> 直接返回
            |
            +-- 未命中 -> 委托给 SimpleExecutor
                    |
                    +-- 检查一级缓存
                            |
                            +-- 命中 -> 返回
                            |
                            +-- 未命中 -> 查询数据库
                                    |
                                    +-- 结果存入一级缓存
                                    |
                                    +-- SqlSession 关闭/提交时
                                        -> 结果写入二级缓存
```

### 4.3 跨 Session 脏读风险（重要！）

二级缓存存在**脏读问题**，在多表关联查询或分布式环境下尤为突出：

```
场景：用户表和用户详情表

时间线：
T1: Session1 查询用户 -> 结果缓存到 UserMapper 二级缓存
T2: Session2 更新用户详情 -> 清除 UserDetailMapper 缓存
T3: Session1 再次查询用户（关联详情）-> 命中 UserMapper 缓存（脏数据！）
```

**生产环境的解决方案：**

1. **使用 Redis 替代二级缓存**——通过 MyBatis-Redis 插件实现分布式缓存
2. **细粒度缓存管理**——只缓存不常变的数据（如字典表、配置表）
3. **设置合理的 flushInterval**——定期刷新，容忍短暂不一致

```java
// 自定义 Redis 缓存实现
public class RedisCache implements Cache {
    private final ReadWriteLock readWriteLock = new ReentrantReadWriteLock();
    private final String id;
    private RedisTemplate<String, Object> redisTemplate;

    @Override
    public void putObject(Object key, Object value) {
        redisTemplate.opsForValue().set(id + ":" + key.toString(), value);
    }

    @Override
    public Object getObject(Object key) {
        return redisTemplate.opsForValue().get(id + ":" + key.toString());
    }

    @Override
    public Object removeObject(Object key) {
        redisTemplate.delete(id + ":" + key.toString());
        return null;
    }
}
```

---

## 五、动态 SQL 详解

MyBatis 的动态 SQL 是其最强大的特性之一，基于 OGNL 表达式实现条件拼接。

### 5.1 `<if>` 条件判断

```xml
<select id="selectUsers" resultType="User">
    SELECT * FROM t_user
    WHERE status = 1
    <if test="userName != null and userName != ''">
        AND user_name LIKE CONCAT('%', #{userName}, '%')
    </if>
    <if test="email != null">
        AND email = #{email}
    </if>
    <if test="createTime != null">
        AND create_time >= #{createTime}
    </if>
</select>
```

### 5.2 `<where>` 智能前缀

`<where>` 标签会自动添加 `WHERE` 关键字，并去除开头的 `AND/OR`：

```xml
<select id="searchUsers" resultType="User">
    SELECT * FROM t_user
    <where>
        <if test="status != null">
            AND status = #{status}
        </if>
        <if test="roleName != null">
            AND role_name = #{roleName}
        </if>
    </where>
    ORDER BY create_time DESC
</select>
```

### 5.3 `<choose>/<when>/<otherwise>`——类似 switch-case

```xml
<select id="selectByCondition" resultType="Order">
    SELECT * FROM t_order
    <where>
        <choose>
            <when test="orderType == 'PAID'">
                AND pay_status = 1 AND refund_status = 0
            </when>
            <when test="orderType == 'REFUND'">
                AND refund_status = 1
            </when>
            <when test="orderType == 'CLOSED'">
                AND order_status = 9
            </when>
            <otherwise>
                AND order_status IN (0, 1, 2)
            </otherwise>
        </choose>
    </where>
</select>
```

### 5.4 `<foreach>` 循环

```xml
<!-- IN 查询 -->
<select id="selectByIds" resultType="User">
    SELECT * FROM t_user
    WHERE id IN
    <foreach collection="ids" item="id" open="(" separator="," close=")">
        #{id}
    </foreach>
</select>

<!-- 批量插入 -->
<insert id="batchInsert">
    INSERT INTO t_log (user_id, action, create_time)
    VALUES
    <foreach collection="logs" item="log" separator=",">
        (#{log.userId}, #{log.action}, #{log.createTime})
    </foreach>
</insert>
```

### 5.5 `<trim>` 自定义前缀处理

`<trim>` 是 `<where>`、`<set>` 的底层实现：

```xml
<update id="updateUser">
    UPDATE t_user
    <trim prefix="SET" suffixOverrides=",">
        <if test="userName != null">user_name = #{userName},</if>
        <if test="email != null">email = #{email},</if>
        <if test="status != null">status = #{status},</if>
        update_time = NOW()
    </trim>
    WHERE id = #{id}
</update>
```

---

## 六、参数处理：#{} vs ${} 与 SQL 注入防护

### 6.1 核心区别

| 特性 | `#{}` 预编译参数 | `${}` 字符串替换 |
|------|-----------------|-----------------|
| 底层机制 | PreparedStatement 的 `?` 占位符 | 字符串拼接 |
| SQL 注入 | 完全防护 | 存在注入风险 |
| 类型处理 | 自动类型转换 | 原样替换 |
| 适用场景 | 绝大多数参数 | 动态表名、列名、ORDER BY |

```xml
<!-- 安全：预编译参数 -->
<select id="selectByName" resultType="User">
    SELECT * FROM t_user WHERE user_name = #{userName}
    <!-- 生成: SELECT * FROM t_user WHERE user_name = ? -->
</select>

<!-- 动态表名场景（必须用 ${}） -->
<select id="selectFromTable" resultType="Map">
    SELECT * FROM ${tableName}
    <!-- 注意：tableName 必须由服务端校验白名单！ -->
</select>
```

### 6.2 SQL 注入防护最佳实践

```java
// 服务端白名单校验
public class SqlInjectionGuard {
    private static final Set<String> ALLOWED_TABLES = Set.of(
        "t_user", "t_order", "t_product", "t_log"
    );
    private static final Set<String> ALLOWED_COLUMNS = Set.of(
        "id", "user_name", "create_time", "status"
    );

    public static String safeTableName(String tableName) {
        if (!ALLOWED_TABLES.contains(tableName)) {
            throw new SecurityException("非法表名: " + tableName);
        }
        return tableName;
    }

    public static String safeOrderBy(String column, String direction) {
        if (!ALLOWED_COLUMNS.contains(column)) {
            throw new SecurityException("非法排序列: " + column);
        }
        if (!"ASC".equalsIgnoreCase(direction) && !"DESC".equalsIgnoreCase(direction)) {
            throw new SecurityException("非法排序方向: " + direction);
        }
        return column + " " + direction.toUpperCase();
    }
}
```

### 6.3 ParameterType 映射规则

```
Java 类型              -> MyBatis TypeHandler       -> JDBC 类型
-------------------------------------------------------------------
String                 -> StringTypeHandler          -> VARCHAR
Integer/int            -> IntegerTypeHandler         -> INTEGER
Long/long              -> LongTypeHandler            -> BIGINT
BigDecimal             -> BigDecimalTypeHandler      -> DECIMAL
Date                   -> DateTypeHandler            -> TIMESTAMP
LocalDateTime          -> LocalDateTimeTypeHandler   -> TIMESTAMP
byte[]                 -> ByteArrayTypeHandler       -> BLOB
自定义枚举              -> 需注册 EnumTypeHandler      -> VARCHAR/INTEGER
```

自定义 TypeHandler 示例：

```java
@MappedTypes(JsonNode.class)
@MappedJdbcTypes(JdbcType.VARCHAR)
public class JsonNodeTypeHandler extends BaseTypeHandler<JsonNode> {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public void setNonNullParameter(PreparedStatement ps, int i, JsonNode param, JdbcType jdbcType) {
        ps.setString(i, param.toString());
    }

    @Override
    public JsonNode getNullableResult(ResultSet rs, String columnName) {
        return parseJson(rs.getString(columnName));
    }

    private JsonNode parseJson(String json) {
        if (json == null) return null;
        try { return MAPPER.readTree(json); }
        catch (Exception e) { throw new RuntimeException(e); }
    }
}
```

---

## 七、ResultMap——结果集映射

### 7.1 基础映射与手动映射

```xml
<resultMap id="userResultMap" type="com.example.entity.User">
    <!-- id 标签标记主键，优化嵌套查询性能 -->
    <id column="id" property="id" jdbcType="BIGINT"/>
    <!-- result 标签映射普通字段 -->
    <result column="user_name" property="userName"/>
    <result column="email" property="email"/>
    <result column="create_time" property="createTime"/>
    <result column="status" property="status"
            typeHandler="com.example.handler.StatusEnumTypeHandler"/>
</resultMap>
```

### 7.2 `<association>` 一对一嵌套查询

```xml
<resultMap id="orderWithUserMap" type="Order">
    <id column="id" property="id"/>
    <result column="order_no" property="orderNo"/>
    <result column="amount" property="amount"/>
    <!-- 嵌套结果：一次查询获取关联数据 -->
    <association property="user" javaType="User">
        <id column="user_id" property="id"/>
        <result column="user_name" property="userName"/>
    </association>
</resultMap>

<select id="selectOrderWithUser" resultMap="orderWithUserMap">
    SELECT o.id, o.order_no, o.amount, o.user_id, u.user_name
    FROM t_order o
    LEFT JOIN t_user u ON o.user_id = u.id
    WHERE o.id = #{orderId}
</select>
```

**懒加载嵌套查询（推荐用于非必需关联）：**

```xml
<resultMap id="orderLazyMap" type="Order">
    <id column="id" property="id"/>
    <result column="order_no" property="orderNo"/>
    <!-- column 传递参数，select 指定子查询 -->
    <association property="user"
                 column="user_id"
                 select="com.example.mapper.UserMapper.selectById"
                 fetchType="lazy"/>
</resultMap>
```

### 7.3 `<collection>` 一对多嵌套查询

```xml
<resultMap id="userWithOrdersMap" type="User">
    <id column="id" property="id"/>
    <result column="user_name" property="userName"/>
    <collection property="orders" ofType="Order" column="id"
                select="selectOrdersByUserId" fetchType="lazy"/>
</resultMap>

<resultMap id="orderSimpleMap" type="Order">
    <id column="id" property="id"/>
    <result column="order_no" property="orderNo"/>
    <result column="amount" property="amount"/>
</resultMap>

<select id="selectOrdersByUserId" resultMap="orderSimpleMap">
    SELECT id, order_no, amount FROM t_order WHERE user_id = #{userId}
</select>
```

---

## 八、分页实现方案对比

### 8.1 RowBounds——内存分页（不推荐）

```java
// 查出全部数据后在内存中截取，数据量大时 OOM！
RowBounds rowBounds = new RowBounds(0, 10);
List<User> users = sqlSession.selectList("selectAllUsers", null, rowBounds);
```

**问题：** RowBounds 在 Executor 层拦截，先查出所有结果，再在内存中 skip + limit。对于百万级数据完全不可用。

### 8.2 PageHelper 插件——SQL 改写分页（生产推荐）

```xml
<!-- pom.xml -->
<dependency>
    <groupId>com.github.pagehelper</groupId>
    <artifactId>pagehelper-spring-boot-starter</artifactId>
    <version>1.4.7</version>
</dependency>
```

```java
// Service 层使用
public PageResult<User> queryUsers(UserQuery query) {
    // 拦截下一条 SQL，自动追加 LIMIT
    PageHelper.startPage(query.getPageNum(), query.getPageSize());
    List<User> list = userMapper.selectByCondition(query);
    PageInfo<User> pageInfo = new PageInfo<>(list);

    return PageResult.<User>builder()
        .list(pageInfo.getList())
        .total(pageInfo.getTotal())
        .pages(pageInfo.getPages())
        .build();
}
```

**PageHelper 原理：** 通过 MyBatis 拦截器在 SQL 执行前改写 SQL：

```sql
-- 原始 SQL
SELECT * FROM t_user WHERE status = 1 ORDER BY create_time DESC

-- 改写后的 SQL（MySQL 方言）
SELECT * FROM t_user WHERE status = 1 ORDER BY create_time DESC LIMIT 0, 10

-- 同时自动执行 COUNT 查询
SELECT COUNT(*) FROM t_user WHERE status = 1
```

### 8.3 手写 LIMIT 分页

```xml
<select id="selectByPage" resultType="User">
    SELECT * FROM t_user
    WHERE status = 1
    ORDER BY create_time DESC
    LIMIT #{offset}, #{pageSize}
</select>

<select id="countByCondition" resultType="long">
    SELECT COUNT(*) FROM t_user WHERE status = 1
</select>
```

---

## 九、MyBatis-Plus 增强特性

### 9.1 CRUD 增强

```java
public interface UserMapper extends BaseMapper<User> {
    // BaseMapper 已内置：
    // insert, deleteById, updateById, selectById
    // selectBatchIds, selectList, selectPage
    // selectCount, selectMaps, selectObjs
}

// 使用示例
@Service
public class UserService {
    @Autowired
    private UserMapper userMapper;

    public void examples() {
        // 主键查询
        User user = userMapper.selectById(1L);

        // 条件查询
        List<User> users = userMapper.selectList(
            new LambdaQueryWrapper<User>()
                .eq(User::getStatus, 1)
                .like(User::getUserName, "张")
                .orderByDesc(User::getCreateTime)
        );

        // 分页查询
        Page<User> page = new Page<>(1, 10);
        IPage<User> result = userMapper.selectPage(page,
            new LambdaQueryWrapper<User>().eq(User::getStatus, 1));
    }
}
```

### 9.2 逻辑删除

```java
@Data
@TableName("t_user")
public class User {
    @TableId(type = IdType.AUTO)
    private Long id;

    @TableLogic(value = "0", delval = "1")
    private Integer deleted;  // 0-正常 1-已删除
}

// MyBatis-Plus 自动改写 SQL：
// DELETE -> UPDATE t_user SET deleted = 1 WHERE id = ?
// SELECT -> SELECT * FROM t_user WHERE deleted = 0 AND ...
```

### 9.3 乐观锁

```java
@Data
public class Product {
    @TableId
    private Long id;
    private String name;
    private BigDecimal price;

    @Version  // 版本号
    private Integer version;
}

// 自动生成带版本号的 UPDATE：
// UPDATE t_product SET name=?, price=?, version=version+1
// WHERE id=? AND version=#{oldVersion}
```

---

## 十、插件机制——四大拦截点

### 10.1 拦截器原理

MyBatis 使用 **JDK 动态代理 + 责任链模式** 实现插件机制，可以拦截以下四个核心对象的方法：

| 拦截对象 | 可拦截方法 | 典型应用 |
|---------|-----------|---------|
| Executor | update, query, commit, rollback | 分页、读写分离 |
| StatementHandler | prepare, parameterize, batch | SQL 改写、慢查询监控 |
| ParameterHandler | setParameters | 参数加密 |
| ResultSetHandler | handleResultSets | 结果脱敏 |

### 10.2 自定义拦截器示例——慢 SQL 监控

```java
@Intercepts({
    @Signature(type = StatementHandler.class, method = "prepare",
               args = {Connection.class, Integer.class})
})
public class SlowSqlInterceptor implements Interceptor {
    private static final long SLOW_THRESHOLD_MS = 500;

    @Override
    public Object intercept(Invocation invocation) throws Throwable {
        StatementHandler handler = (StatementHandler) invocation.getTarget();
        // 解包代理对象获取真实 handler
        MetaObject metaObject = SystemMetaObject.forObject(handler);
        String sql = (String) metaObject.getValue("delegate.boundSql.sql");

        long start = System.currentTimeMillis();
        try {
            return invocation.proceed();
        } finally {
            long elapsed = System.currentTimeMillis() - start;
            if (elapsed > SLOW_THRESHOLD_MS) {
                log.warn("[慢SQL告警] 耗时: {}ms, SQL: {}", elapsed, sql.trim());
                // 可推送到监控系统
                MetricsCollector.recordSlowSql(sql, elapsed);
            }
        }
    }
}
```

### 10.3 拦截器注册

```xml
<!-- mybatis-config.xml -->
<plugins>
    <plugin interceptor="com.example.interceptor.SlowSqlInterceptor"/>
    <plugin interceptor="com.example.interceptor.DataMaskInterceptor"/>
</plugins>

<!-- Spring Boot 配置方式 -->
<bean class="com.example.interceptor.SlowSqlInterceptor"/>
<!-- 或使用 @Configuration 类注册 -->
```

---

## 十一、面试题精选

### Q1：MyBatis 的一级缓存什么时候失效？

**答：** 四种情况：(1) SqlSession 不同；(2) 同一 SqlSession 但查询参数不同；(3) 在两次查询之间执行了增删改操作（内部调用 `clearLocalCache`）；(4) 手动调用 `clearCache()`。

### Q2：为什么 MyBatis 二级缓存可能产生脏读？

**答：** 二级缓存以 namespace 为维度。当两个 Mapper 查询关联数据时，A Mapper 的更新只清除 A 的缓存，不影响 B 的缓存。例如 UserMapper 缓存了用户数据，OrderMapper 的更新不会清除 UserMapper 的缓存，导致读到旧数据。生产环境推荐用 Redis 替代 MyBatis 二级缓存。

### Q3：#{} 和 ${} 有什么区别？

**答：** `#{}` 使用 PreparedStatement 预编译，参数用 `?` 占位符，可以有效防止 SQL 注入。`${}` 是字符串直接拼接，存在注入风险，只应用于动态表名、列名等无法预编译的场景，且必须在服务端做白名单校验。

### Q4：MyBatis 插件的拦截机制是什么？

**答：** 基于 JDK 动态代理。MyBatis 在创建 Executor、StatementHandler、ParameterHandler、ResultSetHandler 时，检查是否有匹配的 Interceptor，如果有则用代理对象包装原对象。多个拦截器形成嵌套代理链，按配置顺序从外到内执行。

### Q5：如何实现 MyBatis 的读写分离？

**答：** 通过自定义拦截器，在 Executor 层判断 SQL 类型（SELECT/INSERT），配合 `AbstractRoutingDataSource` 动态切换数据源。SELECT 操作路由到从库，INSERT/UPDATE/DELETE 路由到主库。需要注意事务中的读操作应该走主库，避免主从延迟导致数据不一致。

### Q6：MyBatis 执行流程中，如果 Mapper 方法有多个参数怎么办？

**答：** MyBatis 默认使用 `param1`、`param2` ... `paramN` 作为参数名。推荐的做法是使用 `@Param` 注解显式命名：`@Param("userId") Long userId, @Param("status") Integer status`。在 XML 中直接用 `#{userId}`、`#{status}` 引用。

---

## 总结

MyBatis 的核心设计可以概括为三个关键词：**代理**（MapperProxy 动态代理）、**缓存**（一级 + 二级双层缓存体系）、**扩展**（插件拦截器机制）。理解了这三个核心，就掌握了 MyBatis 的本质。在实际项目中，还需要结合 MyBatis-Plus 的开发效率增强、Redis 分布式缓存、PageHelper 分页插件等工具，构建高性能的持久层方案。
