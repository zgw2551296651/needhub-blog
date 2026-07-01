# SpringCloud 微服务架构全解析——从注册中心到服务治理

> 本文系统性地梳理 SpringCloud 微服务体系，从架构演进到核心组件原理，从通信模式到生产级技术选型，深入分析 Nacos、Feign、Gateway、熔断降级、负载均衡等核心模块的设计思想与实战应用。适合正在构建或维护微服务架构的中高级开发者。

---

## 一、微服务核心概念与架构演进

### 1.1 从单体到微服务的演进

软件架构的发展经历了三个主要阶段：

```
阶段一：单体架构（Monolith）
+------------------------------------------+
|              单体应用                      |
| +--------+ +--------+ +--------+         |
| | 用户模块| | 订单模块| | 支付模块|         |
| +--------+ +--------+ +--------+         |
| +--------+ +--------+ +---------+        |
| | 库存模块| | 营销模块| | 消息模块 |        |
| +--------+ +--------+ +---------+        |
|              共享数据库                     |
+------------------------------------------+

阶段二：垂直拆分（Vertical Split）
按业务线拆分为独立应用，各自独立部署和数据库

阶段三：微服务架构（Microservices）
+-----------+  +-----------+  +-----------+
| 用户服务   |  | 订单服务   |  | 支付服务   |
| :8081     |  | :8082     |  | :8083     |
+-----------+  +-----------+  +-----------+
      |              |              |
      +--------+-----+------+-------+
               |            |
         +-----v-----+ +----v------+
         | API Gateway| | 注册中心  |
         +-----------+ +-----------+
```

### 1.2 单体架构的痛点

| 痛点 | 具体表现 |
|------|---------|
| 部署耦合 | 修改一行代码需要重新部署整个应用 |
| 扩展困难 | 只能整体扩容，无法针对热点服务单独扩展 |
| 技术栈锁定 | 所有模块必须使用相同技术栈和框架版本 |
| 故障传播 | 一个模块的 OOM 可能导致整个应用宕机 |
| 团队协作 | 多个团队修改同一代码库，合并冲突频繁 |
| 启动缓慢 | 大型单体应用启动时间可达 5-10 分钟 |

### 1.3 CAP 定理在微服务中的应用

CAP 定理指出：分布式系统不可能同时满足一致性（Consistency）、可用性（Availability）和分区容错性（Partition Tolerance）。

在微服务架构中的实际选择：

| 系统组件 | CAP 选择 | 原因 |
|---------|---------|------|
| 注册中心（Eureka） | AP | 优先保证服务可发现，容忍短暂不一致 |
| 注册中心（Nacos 临时实例） | AP | 心跳检测，快速感知服务变化 |
| 注册中心（Nacos 持久实例） | CP | Raft 协议，保证数据强一致 |
| 配置中心 | CP | 配置变更需要强一致传播 |
| 分布式锁 | CP | 互斥性要求强一致 |
| 消息队列（Kafka） | AP（默认） | 高吞吐优先，消费者端保证语义 |

---

## 二、SpringCloud 核心组件全景

### 2.1 组件架构总览

```
                          +------------------+
                          |   外部请求入口    |
                          +--------+---------+
                                   |
                          +--------v---------+
                          |   API Gateway    |
                          |  (路由/限流/鉴权) |
                          +--------+---------+
                                   |
                    +--------------+--------------+
                    |              |              |
             +------v------+ +----v-----+ +------v------+
             |  服务 A      | | 服务 B   | |  服务 C      |
             | +----------+| |+--------+| |+----------+ |
             | | OpenFeign|| ||Ribbon  || || Hystrix  | |
             | +----------+| |+--------+| |+----------+ |
             +------+------+ +----+----+ +------+------+
                    |              |              |
             +------v--------------v--------------v------+
             |           注册中心 (Eureka/Nacos)          |
             +--------------------------------------------+
                    |
             +------v------+    +-------------+    +----------+
             | 配置中心     |    | 消息总线     |    | 链路追踪  |
             | (Config/    |    | (Bus)       |    | (Sleuth) |
             |  Nacos)     |    |             |    |          |
             +-------------+    +-------------+    +----------+
```

### 2.2 核心组件详解

**Eureka——注册中心（Netflix 开源）**

Eureka 采用典型的 AP 模型，由 Eureka Server（注册中心集群）和 Eureka Client（服务实例）组成：

```yaml
# Eureka Server 配置
server:
  port: 8761
eureka:
  instance:
    hostname: eureka-server
  client:
    register-with-eureka: false   # 服务端不注册自己
    fetch-registry: false          # 服务端不拉取注册表
  server:
    enable-self-preservation: true # 开启自我保护模式
    eviction-interval-timer-in-ms: 60000  # 过期实例清理间隔
```

**Eureka 服务注册与发现流程：**

```
服务实例启动
    |
    v
向 Eureka Server 发送注册请求 (Register)
    |
    v
每 30 秒发送心跳 (Renew)
    |
    v
Eureka Server 维护注册表
    |
    v
其他服务拉取注册表 (Fetch Registry, 每 30 秒增量拉取)
    |
    v
90 秒未收到心跳 -> 标记下线 (Evict)
```

**Ribbon——客户端负载均衡**

Ribbon 从注册中心获取服务实例列表，在客户端实现负载均衡：

```java
// Ribbon 负载均衡配置
@RibbonClient(name = "order-service", configuration = RibbonConfig.class)

public class RibbonConfig {
    @Bean
    public IRule ribbonRule() {
        return new WeightedResponseTimeRule();  // 基于响应时间加权
    }

    @Bean
    public IPing ribbonPing() {
        return new PingUrl();  // 健康检查方式
    }
}
```

**Hystrix——熔断器**

Hystrix 通过线程池隔离和熔断机制，防止服务雪崩：

```java
@Service
public class OrderService {
    @HystrixCommand(
        fallbackMethod = "getOrderFallback",
        commandProperties = {
            @HystrixProperty(name = "execution.isolation.thread.timeoutInMilliseconds", value = "3000"),
            @HystrixProperty(name = "circuitBreaker.requestVolumeThreshold", value = "20"),
            @HystrixProperty(name = "circuitBreaker.errorThresholdPercentage", value = "50"),
            @HystrixProperty(name = "circuitBreaker.sleepWindowInMilliseconds", value = "5000")
        },
        threadPoolProperties = {
            @HystrixProperty(name = "coreSize", value = "10"),
            @HystrixProperty(name = "maxQueueSize", value = "100")
        }
    )
    public OrderDTO getOrder(Long orderId) {
        return orderFeignClient.getOrder(orderId);
    }

    public OrderDTO getOrderFallback(Long orderId) {
        return OrderDTO.builder()
            .orderId(orderId)
            .status("DEGRADED")
            .message("服务暂时不可用，请稍后重试")
            .build();
    }
}
```

---

## 三、通信模式对比

### 3.1 五种通信模式

```
+------------------------------------------------------------------+
|                    微服务通信模式                                    |
+------------------------------------------------------------------+
|                                                                    |
|  同步通信                                                          |
|  +----------------+  +----------------+  +------------------+     |
|  | REST           |  | Feign          |  | RPC/Dubbo        |     |
|  | (RestTemplate) |  | (声明式HTTP)    |  | (二进制协议)      |     |
|  +----------------+  +----------------+  +------------------+     |
|                                                                    |
|  异步通信                                                          |
|  +-------------------+  +---------------------------+             |
|  | 消息驱动           |  | 事件驱动                   |             |
|  | (Spring Cloud     |  | (Event-Driven Architecture)|             |
|  |  Stream)          |  |                             |             |
|  +-------------------+  +---------------------------+             |
|                                                                    |
|  统一入口                                                          |
|  +-------------------+                                            |
|  | API Gateway       |                                            |
|  | (Spring Cloud     |                                            |
|  |  Gateway)         |                                            |
|  +-------------------+                                            |
+------------------------------------------------------------------+
```

### 3.2 REST（RestTemplate）

最基础的同步通信方式，直接调用 HTTP 接口：

```java
@Configuration
public class RestConfig {
    @Bean
    @LoadBalanced  // 启用 Ribbon 负载均衡
    public RestTemplate restTemplate() {
        HttpComponentsClientHttpRequestFactory factory =
            new HttpComponentsClientHttpRequestFactory();
        factory.setConnectTimeout(3000);   // 连接超时 3 秒
        factory.setReadTimeout(5000);      // 读取超时 5 秒
        return new RestTemplate(factory);
    }
}

@Service
public class UserService {
    @Autowired
    private RestTemplate restTemplate;

    public UserDTO getUser(Long userId) {
        String url = "http://user-service/api/users/{id}";
        return restTemplate.getForObject(url, UserDTO.class, userId);
    }

    public OrderDTO createOrder(OrderRequest request) {
        String url = "http://order-service/api/orders";
        return restTemplate.postForObject(url, request, OrderDTO.class);
    }
}
```

### 3.3 Feign——声明式 HTTP 客户端

Feign 将 HTTP 调用抽象为接口方法调用，底层集成 Ribbon 和 Hystrix：

```java
@FeignClient(
    name = "order-service",
    fallbackFactory = OrderFeignFallbackFactory.class,
    configuration = FeignConfig.class
)
public interface OrderFeignClient {

    @GetMapping("/api/orders/{orderId}")
    OrderDTO getOrder(@PathVariable("orderId") Long orderId);

    @PostMapping("/api/orders")
    OrderDTO createOrder(@RequestBody OrderRequest request);

    @GetMapping("/api/orders")
    PageResult<OrderDTO> queryOrders(@RequestParam("userId") Long userId,
                                      @RequestParam("pageNum") Integer pageNum,
                                      @RequestParam("pageSize") Integer pageSize);

    @DeleteMapping("/api/orders/{orderId}")
    void cancelOrder(@PathVariable("orderId") Long orderId);
}

// 降级工厂
@Component
public class OrderFeignFallbackFactory implements FallbackFactory<OrderFeignClient> {
    @Override
    public OrderFeignClient create(Throwable cause) {
        log.error("OrderService 调用失败: {}", cause.getMessage());
        return new OrderFeignClient() {
            @Override
            public OrderDTO getOrder(Long orderId) {
                return OrderDTO.degraded(orderId);
            }
            @Override
            public OrderDTO createOrder(OrderRequest request) {
                throw new ServiceUnavailableException("订单服务不可用");
            }
            // ... 其他方法
        };
    }
}
```

### 3.4 Feign 演进路线

```
Netflix Feign (已停止维护)
    |
    v
Spring Cloud OpenFeign (当前主流，持续维护)
    |
    v
Spring 6.0 @HttpExchange (未来趋势)
```

**Spring 6.0 @HttpExchange 示例：**

```java
// 定义 HTTP 接口（客户端和服务端共享）
public interface UserApi {
    @GetExchange("/api/users/{id}")
    UserDTO getUser(@PathVariable Long id);

    @PostExchange("/api/users")
    UserDTO createUser(@RequestBody UserRequest request);
}

// 客户端使用
@Configuration
public class HttpClientConfig {
    @Bean
    public UserApi userApi(RestClient.Builder builder) {
        RestClient restClient = builder.baseUrl("http://user-service").build();
        RestClientAdapter adapter = RestClientAdapter.create(restClient);
        HttpServiceProxyFactory factory = HttpServiceProxyFactory.builderFor(adapter).build();
        return factory.createClient(UserApi.class);
    }
}
```

### 3.5 Spring Cloud Stream——消息驱动

```java
// 定义消息通道
public interface OrderChannels {
    @Input("orderInput")
    SubscribableChannel orderInput();

    @Output("orderOutput")
    MessageChannel orderOutput();
}

@EnableBinding(OrderChannels.class)
@Service
public class OrderStreamService {

    @Autowired
    private OrderChannels channels;

    // 发送消息
    public void sendOrderCreatedEvent(OrderEvent event) {
        channels.orderOutput().send(
            MessageBuilder.withPayload(event)
                .setHeader("eventType", "ORDER_CREATED")
                .build()
        );
    }

    // 消费消息
    @StreamListener("orderInput")
    public void handleOrderEvent(OrderEvent event) {
        log.info("收到订单事件: {}", event);
        // 处理业务逻辑
    }
}
```

---

## 四、生产级技术栈选型

### 4.1 推荐的 SpringCloud Alibaba 技术栈

| 功能域 | 推荐组件 | 替代方案 | 说明 |
|--------|---------|---------|------|
| 注册中心 | Nacos | Consul, ZooKeeper | 同时提供配置中心能力 |
| 配置中心 | Nacos | Apollo, Spring Cloud Config | 动态推送能力更强 |
| 服务网关 | Spring Cloud Gateway | Kong, APISIX | 响应式模型，性能优秀 |
| 服务调用 | OpenFeign + Dubbo | gRPC | Dubbo 适合内部高性能 RPC |
| 流量控制 | Sentinel | Hystrix, Resilience4j | 规则丰富，控制台友好 |
| 链路追踪 | SkyWalking | Zipkin, Jaeger | Java 探针无侵入 |
| 分布式事务 | Seata | TCC, SAGA | AT 模式对业务无侵入 |
| 消息队列 | RocketMQ/Kafka | RabbitMQ | 高吞吐、高可靠 |

---

## 五、Nacos 详解——注册与配置一体化

### 5.1 Nacos 架构模型

Nacos 是阿里巴巴开源的动态服务发现、配置管理和服务管理平台。

```
+--------------------------------------------------+
|                  Nacos Server 集群                 |
|                                                    |
|  +-----------+  +-----------+  +-----------+      |
|  | Nacos-1   |  | Nacos-2   |  | Nacos-3   |      |
|  | (Leader)  |  | (Follower)|  | (Follower)|      |
|  +-----+-----+  +-----+-----+  +-----+-----+      |
|        |              |              |              |
|        +--------------+--------------+              |
|                       |                             |
|              +--------v--------+                    |
|              |   Raft 协议      |                    |
|              |  (CP 模式)       |                    |
|              +-----------------+                    |
|                                                      |
|  +-------------------+  +-------------------+      |
|  |  服务注册表        |  |  配置管理中心      |      |
|  |  (AP: 心跳检测)    |  |  (CP: Raft 共识)  |      |
|  +-------------------+  +-------------------+      |
+--------------------------------------------------+
         |              |              |
   +-----v-----+  +----v-----+  +----v------+
   | 服务提供者 |  | 服务消费者|  | 配置客户端 |
   +-----------+  +----------+  +-----------+
```

### 5.2 CP + AP 混合模型

Nacos 支持两种一致性模型，通过实例类型选择：

**临时实例（AP 模式，默认）：**
- 客户端每 5 秒发送心跳
- 服务端 15 秒未收到心跳标记不健康
- 30 秒未收到心跳从注册表移除
- 使用 Distro 协议（AP），各节点独立处理，最终一致

**持久实例（CP 模式）：**
- 数据存储到磁盘，保证不丢失
- 使用 Raft 协议（CP），Leader 负责写入，多数派确认
- 适用于核心基础服务（如数据库代理）

```yaml
spring:
  cloud:
    nacos:
      discovery:
        server-addr: nacos1:8848,nacos2:8848,nacos3:8848
        namespace: production  # 命名空间隔离
        group: DEFAULT_GROUP
        ephemeral: true        # true=临时实例(AP), false=持久实例(CP)
        metadata:
          version: v2.1.0
          region: cn-east
```

### 5.3 Nacos 四大核心能力

**能力一：动态配置管理**

```yaml
# bootstrap.yml
spring:
  cloud:
    nacos:
      config:
        server-addr: nacos:8848
        namespace: ${NACOS_NAMESPACE}
        group: ${NACOS_GROUP:DEFAULT_GROUP}
        file-extension: yaml
        shared-configs:
          - data-id: common-config.yaml
            group: SHARED_GROUP
            refresh: true
        extension-configs:
          - data-id: redis-config.yaml
            group: SHARED_GROUP
            refresh: true
```

```java
// 动态刷新配置
@RefreshScope
@RestController
public class ConfigDemoController {
    @Value("${app.feature.switch}")
    private String featureSwitch;

    @Value("${app.rate-limit.qps}")
    private Integer qpsLimit;

    @GetMapping("/config/demo")
    public String getConfig() {
        return "featureSwitch=" + featureSwitch + ", qpsLimit=" + qpsLimit;
    }
}
```

**能力二：服务发现与注册**

```java
// 手动获取服务实例
@Autowired
private DiscoveryClient discoveryClient;

public List<ServiceInstance> getInstances(String serviceName) {
    return discoveryClient.getInstances(serviceName);
}

// 结合负载均衡使用
@Autowired
private LoadBalancerClient loadBalancerClient;

public ServiceInstance chooseInstance(String serviceName) {
    return loadBalancerClient.choose(serviceName);
}
```

**能力三：服务治理**

```yaml
# Nacos 服务治理配置
spring:
  cloud:
    nacos:
      discovery:
        metadata:
          version: v2.0          # 版本标签
          env: gray              # 环境标签
          weight: 80             # 权重（0-100）
```

**能力四：命名空间隔离**

```
Nacos
  |
  +-- Namespace: dev
  |     +-- Group: DEFAULT_GROUP
  |     |     +-- Service: user-service
  |     |     +-- Service: order-service
  |     +-- Group: PAY_GROUP
  |           +-- Service: payment-service
  |
  +-- Namespace: staging
  |     +-- Group: DEFAULT_GROUP
  |           +-- Service: user-service (staging 版本)
  |
  +-- Namespace: production
        +-- Group: DEFAULT_GROUP
              +-- Service: user-service (生产版本)
```

---

## 六、API Gateway——统一流量入口

### 6.1 Spring Cloud Gateway 架构

Spring Cloud Gateway 基于 **Reactor 模型**（Netty + WebFlux），采用非阻塞 I/O，性能远超 Zuul 1.x 的 Servlet 模型。

```
客户端请求
    |
    v
+------------------+
|  Gateway Server  |
|  (Netty + Reactor)|
+------------------+
    |
    v
+------------------+
|  HandlerMapping  |  <-- 路由匹配（Path/Header/Query/Method）
+------------------+
    |
    v
+------------------+
|  WebHandler      |  <-- 过滤器链执行
|                  |
|  Pre  Filters    |  <-- 请求预处理（鉴权、限流、日志）
|       |          |
|       v          |
|  目标服务调用     |  <-- 通过 NettyRoutingFilter 转发
|       |          |
|       v          |
|  Post Filters    |  <-- 响应后处理（日志、修改响应头）
+------------------+
```

### 6.2 路由配置与过滤器

```yaml
spring:
  cloud:
    gateway:
      routes:
        # 用户服务路由
        - id: user-service
          uri: lb://user-service   # lb:// 表示从注册中心获取实例并负载均衡
          predicates:
            - Path=/api/users/**
            - Method=GET,POST,PUT,DELETE
          filters:
            - StripPrefix=1        # 去除第一层路径前缀
            - name: RequestRateLimiter
              args:
                redis-rate-limiter.replenishRate: 100   # 令牌桶填充速率
                redis-rate-limiter.burstCapacity: 200   # 令牌桶容量
                key-resolver: "#{@ipKeyResolver}"
            - AddRequestHeader=X-Trace-Id, "#{T(java.util.UUID).randomUUID()}"

        # 订单服务路由（带版本灰度）
        - id: order-service-gray
          uri: lb://order-service
          predicates:
            - Path=/api/orders/**
            - Header=X-Gray, true
          filters:
            - StripPrefix=1

        # 全局默认路由
        - id: default-route
          uri: lb://default-service
          predicates:
            - Path=/**
          filters:
            - StripPrefix=0
      # 全局过滤器
      default-filters:
        - name: Retry
          args:
            retries: 3
            statuses: BAD_GATEWAY,SERVICE_UNAVAILABLE
            methods: GET
```

### 6.3 自定义全局过滤器——鉴权

```java
@Component
public class AuthGlobalFilter implements GlobalFilter, Ordered {
    private static final Set<String> WHITE_LIST = Set.of(
        "/api/auth/login", "/api/auth/register", "/api/health"
    );

    @Autowired
    private TokenService tokenService;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String path = exchange.getRequest().getURI().getPath();

        // 白名单放行
        if (WHITE_LIST.contains(path)) {
            return chain.filter(exchange);
        }

        // 提取 Token
        String token = exchange.getRequest().getHeaders().getFirst("Authorization");
        if (token == null || !token.startsWith("Bearer ")) {
            return unauthorized(exchange, "缺少认证令牌");
        }

        // 验证 Token
        return tokenService.validateToken(token.substring(7))
            .flatMap(user -> {
                // 将用户信息注入请求头
                ServerHttpRequest request = exchange.getRequest().mutate()
                    .header("X-User-Id", user.getUserId().toString())
                    .header("X-User-Role", user.getRole())
                    .build();
                return chain.filter(exchange.mutate().request(request).build());
            })
            .onErrorResume(e -> unauthorized(exchange, "Token 验证失败: " + e.getMessage()));
    }

    private Mono<Void> unauthorized(ServerWebExchange exchange, String message) {
        exchange.getResponse().setStatusCode(HttpStatus.UNAUTHORIZED);
        exchange.getResponse().getHeaders().setContentType(MediaType.APPLICATION_JSON);
        String body = "{\"code\":401,\"message\":\"" + message + "\"}";
        return exchange.getResponse().writeWith(
            Mono.just(exchange.getResponse().bufferFactory().wrap(body.getBytes()))
        );
    }

    @Override
    public int getOrder() {
        return -100;  // 高优先级
    }
}
```

---

## 七、熔断降级——防止服务雪崩

### 7.1 Hystrix 熔断状态转换

```
                    错误率 >= 50%
                    (窗口期内 >= 20 次请求)
    +--------+  =========================>  +--------+
    |  CLOSED|                              |  OPEN  |
    | (正常) |  <=========================  | (熔断) |
    +--------+   5秒后进入半开状态            +--------+
         ^          探测请求成功                |
         |                                     |
         |      +----------+                   |
         +------| HALF-OPEN| <-----------------+
                | (半开)    |   探测请求失败
                +----------+   回到 OPEN 状态
```

### 7.2 线程池隔离 vs 信号量隔离

| 维度 | 线程池隔离 | 信号量隔离 |
|------|-----------|-----------|
| 隔离粒度 | 每个服务一个独立线程池 | 共享 Tomcat 线程，用信号量限流 |
| 异步支持 | 支持（Future） | 不支持 |
| 性能开销 | 高（线程切换） | 低 |
| 超时控制 | 支持 | 不支持 |
| 适用场景 | 外部 HTTP 调用 | 内部高频调用、Redis 访问 |

### 7.3 Sentinel vs Hystrix 对比

| 特性 | Sentinel | Hystrix |
|------|----------|---------|
| 隔离策略 | 并发线程数/信号量 | 线程池隔离/信号量 |
| 熔断策略 | 响应时间/异常比率 | 异常比率 |
| 限流 | QPS、线程数、多种策略 | 有限支持 |
| 实时指标 | 滑动窗口（LeapArray） | 滑动窗口（RxJava） |
| 动态规则 | 支持多种数据源（Nacos、Redis） | 支持多种数据源 |
| 控制台 | 提供开箱即用的控制台 | 简单的监控 |
| 维护状态 | 活跃维护 | 已停止维护 |

**Sentinel 限流配置示例：**

```java
@Component
public class SentinelConfig {
    @PostConstruct
    public void initRules() {
        // QPS 限流规则
        List<FlowRule> rules = new ArrayList<>();
        FlowRule rule = new FlowRule();
        rule.setResource("getOrderDetail");
        rule.setGrade(RuleConstant.FLOW_GRADE_QPS);
        rule.setCount(100);  // QPS 上限
        rule.setControlBehavior(RuleConstant.CONTROL_BEHAVIOR_WARM_UP);  // 预热模式
        rule.setWarmUpPeriodSec(10);  // 预热时长
        rules.add(rule);
        FlowRuleManager.loadRules(rules);

        // 熔断规则
        List<DegradeRule> degradeRules = new ArrayList<>();
        DegradeRule degradeRule = new DegradeRule();
        degradeRule.setResource("getOrderDetail");
        degradeRule.setGrade(CircuitBreakerStrategy.SLOW_REQUEST_RATIO.getType());
        degradeRule.setCount(0.5);     // 慢调用比例 50%
        degradeRule.setSlowRatioThreshold(500);  // 慢调用阈值 500ms
        degradeRule.setTimeWindow(10);  // 熔断时长 10 秒
        degradeRule.setMinRequestAmount(20);  // 最小请求数
        degradeRules.add(degradeRule);
        DegradeRuleManager.loadRules(degradeRules);
    }
}
```

---

## 八、负载均衡策略详解

### 8.1 五种核心策略

```java
public class LoadBalancerStrategies {

    // 1. 随机（RandomRule）
    // 简单随机选择，适合实例性能均匀的场景
    public ServiceInstance random(List<ServiceInstance> instances) {
        return instances.get(ThreadLocalRandom.current().nextInt(instances.size()));
    }

    // 2. 轮询（RoundRobinRule）
    // 按顺序依次分配，最均匀的分配方式
    private AtomicInteger counter = new AtomicInteger(0);
    public ServiceInstance roundRobin(List<ServiceInstance> instances) {
        int index = counter.getAndIncrement() % instances.size();
        return instances.get(index);
    }

    // 3. 最少活跃连接（LeastActiveRule/Dubbo）
    // 选择活跃请求数最少的实例，自动适应实例性能差异
    public ServiceInstance leastActive(Map<ServiceInstance, Integer> activeCounts) {
        return activeCounts.entrySet().stream()
            .min(Map.Entry.comparingByValue())
            .map(Map.Entry::getKey)
            .orElse(null);
    }

    // 4. 最短响应时间（WeightedResponseTimeRule）
    // 根据响应时间动态调整权重，响应越快权重越高
    // weight = totalResponseTime / (instanceResponseTime * instanceCount)

    // 5. 一致性哈希（ConsistentHash）
    // 相同参数的请求始终路由到同一实例，适合有状态服务
    public ServiceInstance consistentHash(List<ServiceInstance> instances, String key) {
        // 使用虚拟节点的一致性哈希环
        TreeMap<Long, ServiceInstance> ring = buildHashRing(instances, 150);
        long hash = murmurHash(key);
        Map.Entry<Long, ServiceInstance> entry = ring.ceilingEntry(hash);
        return entry != null ? entry.getValue() : ring.firstEntry().getValue();
    }
}
```

---

## 九、服务治理——灰度发布与 A/B 测试

### 9.1 灰度发布流程

```
+---------+      +--------+      +-------------------+
| 外部流量 |  --> | Gateway |  --> |  路由规则引擎       |
+---------+      +--------+      +-------------------+
                                          |
                         +----------------+----------------+
                         |                                 |
                  +------v------+                  +-------v-----+
                  |  稳定版 v1.0 |                  |  灰度版 v2.0 |
                  |  (90% 流量)  |                  |  (10% 流量)  |
                  +--------------+                  +-------------+
```

**基于请求头的灰度路由实现：**

```java
@Component
public class GrayLoadBalancer implements ReactorServiceInstanceLoadBalancer {
    @Override
    public Mono<Response<ServiceInstance>> choose(Request request) {
        return serviceInstances.get().map(instances -> {
            // 提取请求头中的灰度标识
            String grayTag = getHeaderValue(request, "X-Gray-Tag");
            String version = getHeaderValue(request, "X-App-Version");

            // 按标签路由
            List<ServiceInstance> targets = instances.stream()
                .filter(i -> matchMetadata(i, "version", version))
                .collect(Collectors.toList());

            if (targets.isEmpty()) {
                // 降级到默认版本
                targets = instances.stream()
                    .filter(i -> "v1.0".equals(i.getMetadata().get("version")))
                    .collect(Collectors.toList());
            }

            // 在匹配的实例中随机选择
            ServiceInstance chosen = targets.get(
                ThreadLocalRandom.current().nextInt(targets.size()));
            return new DefaultResponse(chosen);
        });
    }
}
```

### 9.2 Mock 降级策略

```java
@Component
public class MockServiceManager {
    // 服务降级时返回 Mock 数据
    @Bean
    public MockDataProvider orderMockProvider() {
        return new MockDataProvider() {
            @Override
            public Object provide(String method, Object[] args) {
                switch (method) {
                    case "getOrderDetail":
                        return OrderDTO.builder()
                            .status("MOCK")
                            .message("服务维护中，显示缓存数据")
                            .build();
                    case "getOrderList":
                        return Collections.emptyList();
                    default:
                        throw new ServiceUnavailableException("服务不可用");
                }
            }
        };
    }
}
```

---

## 十、面试题精选

### Q1：Eureka 的自我保护模式是什么？

**答：** 当 Eureka Server 在 15 分钟内收到心跳比例低于 85% 时，会进入自我保护模式。此时不会剔除任何服务实例，即使它们长时间未发送心跳。这是为了应对网络分区问题——在网络不稳定时，宁可保留可能已下线实例的信息，也不误删健康实例。保护模式下，客户端仍能正常查询和调用已注册的服务。

### Q2：Nacos 和 Eureka 的区别？

**答：** (1) Nacos 同时提供服务注册和配置管理能力，Eureka 只做服务注册；(2) Nacos 支持 AP（临时实例）和 CP（持久实例）两种一致性模型，Eureka 只有 AP；(3) Nacos 支持服务端主动推送变更通知，Eureka 依赖客户端定时拉取（30秒）；(4) Nacos 支持命名空间隔离，方便多环境管理；(5) Nacos 仍在活跃维护，Eureka 2.x 已停止开发。

### Q3：Gateway 和 Zuul 有什么区别？

**答：** Zuul 1.x 基于 Servlet 的阻塞 I/O 模型，每个请求占用一个线程。Spring Cloud Gateway 基于 Netty + Reactor 的非阻塞异步模型，少量线程即可处理大量并发连接，性能更高。此外 Gateway 原生支持响应式编程、内置了限流（RequestRateLimiter）、熔断等过滤器，路由规则也更加灵活（支持 Path、Header、Query、Method 等多种 Predicate）。

### Q4：Hystrix 线程池隔离和信号量隔离的区别？

**答：** 线程池隔离为每个服务创建独立的线程池，请求在新线程中执行，支持异步和超时控制，但有线程切换开销。信号量隔离使用 Tomcat 线程，通过 Semaphore 控制并发数，性能更高但不支持异步和超时。推荐：外部 HTTP 调用用线程池隔离，内部高频调用（如 Redis）用信号量隔离。

### Q5：如何实现微服务的灰度发布？

**答：** (1) 在注册中心为不同版本的实例打上 metadata 标签（如 version=v1/v2）；(2) Gateway 层根据请求头（X-Gray-Tag）、用户ID、IP等维度进行流量染色；(3) 自定义负载均衡器按标签路由到对应版本的实例；(4) 逐步调整灰度比例（如 5% → 20% → 50% → 100%），观察监控指标；(5) 确认稳定后全量切换到新版本。

### Q6：SpringCloud 各组件之间的调用链路是怎样的？

**答：** 请求 → Gateway（路由匹配 + 过滤器链）→ Ribbon/LoadBalancer（从注册中心获取实例列表 + 负载均衡选择）→ Feign/RestTemplate（构造 HTTP 请求）→ Hystrix/Sentinel（熔断 + 降级保护）→ 目标服务实例。其中 Nacos 作为注册中心提供服务发现，作为配置中心提供动态配置，Sleuth/SkyWalking 贯穿整个链路进行追踪。

### Q7：微服务间传递用户上下文怎么做？

**答：** (1) Gateway 层解析 Token，将 userId、role 等信息注入请求头 X-User-Id、X-User-Role；(2) 下游服务通过 Feign 的 RequestInterceptor 自动透传这些 Header；(3) 服务内部通过 ThreadLocal 存储上下文；(4) 异步调用（@Async）需要手动传递 ThreadLocal，或使用 TransmittableThreadLocal（TTL）解决线程池场景的上下文丢失。

---

## 总结

SpringCloud 微服务体系的核心可以归纳为三个关键问题：**服务在哪里**（注册中心 Nacos/Eureka）、**如何调用**（Feign + Ribbon + Gateway）、**如何保障**（Sentinel/Hystrix 熔断降级 + 限流）。在实际生产中，推荐采用 SpringCloud Alibaba 技术栈（Nacos + Sentinel + Gateway + Dubbo），它在国内互联网公司的实践中得到了充分验证，社区活跃度高，文档完善，是当前最主流的 SpringCloud 落地方案。
