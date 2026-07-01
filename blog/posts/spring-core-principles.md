# Spring 框架核心原理详解——IOC、AOP 与 Bean 生命周期

## 引言

Spring 框架自 2003 年诞生以来，已经成为 Java 企业级开发的事实标准。无论是传统的 Spring MVC 项目，还是现代的 Spring Boot 微服务应用，Spring 都以其优雅的设计理念和强大的功能支撑着数以百万计的企业应用。

### Spring 在 Java 生态中的地位

Spring 的出现彻底改变了 Java EE 开发的复杂性。在 EJB（Enterprise JavaBean）时代，开发者需要面对繁琐的部署描述符、重量级的容器依赖以及复杂的远程调用机制。Spring 以轻量化、POJO 编程模型和依赖注入为核心，为开发者提供了一种更为简洁、高效的开发方式。

如今，Spring 生态已经涵盖了从 Web 开发（Spring MVC）、数据访问（Spring Data）、安全认证（Spring Security）到微服务架构（Spring Cloud）的方方面面。理解 Spring 的核心原理，不仅是面试的必备技能，更是成为高级 Java 工程师的必经之路。

### 理解 Spring 核心原理的重要性

很多开发者在使用 Spring 时，往往只停留在"会用"的层面——知道如何配置注解、如何注入 Bean、如何使用 AOP。但当遇到以下问题时，往往束手无策：

- 为什么会出现循环依赖错误？
- @Transactional 为什么在某些场景下失效？
- Bean 的初始化顺序是怎样的？
- AOP 代理是如何生成的？

这些问题的答案，都隐藏在 Spring 的源码中。本文将深入剖析 Spring 的核心原理，结合源码分析和实战案例，帮助你真正理解 Spring 的设计精髓。

---

## 一、IOC（控制反转）与 DI（依赖注入）

### 1.1 什么是控制反转

**IOC（Inversion of Control，控制反转）** 是 Spring 最核心的设计思想。要理解 IOC，我们先看传统的对象创建方式：

```java
// 传统方式：对象自己控制依赖的创建
public class UserService {
    private UserDao userDao = new UserDaoImpl();

    public void save(User user) {
        userDao.save(user);
    }
}
```

在这种方式下，`UserService` 直接通过 `new` 关键字创建了 `UserDao` 的实例。这意味着：

1. **强耦合**：`UserService` 与 `UserDaoImpl` 紧密绑定，如果要更换实现类，必须修改源代码。
2. **难以测试**：单元测试时无法轻松替换 `UserDao` 为 Mock 对象。
3. **职责混乱**：`UserService` 不仅要处理业务逻辑，还要负责创建依赖对象。

**IOC 的核心思想是：将对象的创建和管理权交给外部容器（Spring 容器），而不是由对象自己控制。**

```java
// IOC 方式：容器负责注入依赖
public class UserService {
    private UserDao userDao;

    // 通过构造器注入
    public UserService(UserDao userDao) {
        this.userDao = userDao;
    }

    public void save(User user) {
        userDao.save(user);
    }
}
```

在这个例子中，`UserService` 不再关心 `UserDao` 是如何创建的，而是被动地等待容器将依赖注入进来。这就是"控制反转"——控制权从对象自身转移到了外部容器。

### 1.2 依赖注入的方式

**DI（Dependency Injection，依赖注入）** 是 IOC 的具体实现方式。Spring 提供了三种主要的注入方式：

#### 1. 构造器注入（推荐）

```java
@Service
public class UserService {
    private final UserDao userDao;
    private final EmailService emailService;

    @Autowired
    public UserService(UserDao userDao, EmailService emailService) {
        this.userDao = userDao;
        this.emailService = emailService;
    }
}
```

**优点：**
- 依赖项可以声明为 `final`，保证不可变性
- 对象创建时依赖就已就绪，不会出现空指针
- Spring 官方推荐的方式

**缺点：**
- 当依赖项较多时，构造器参数列表会很长

#### 2. Setter 注入

```java
@Service
public class UserService {
    private UserDao userDao;

    @Autowired
    public void setUserDao(UserDao userDao) {
        this.userDao = userDao;
    }
}
```

**优点：**
- 灵活性高，可以在运行时动态修改依赖
- 适合可选依赖

**缺点：**
- 无法将依赖声明为 `final`
- 可能出现依赖未注入就使用的情况

#### 3. 字段注入（@Autowired）

```java
@Service
public class UserService {
    @Autowired
    private UserDao userDao;
}
```

**优点：**
- 代码最简洁

**缺点：**
- 隐藏了依赖关系，不利于代码审查
- 无法在单元测试中轻松注入 Mock 对象
- Spring 官方不推荐在新项目中使用

### 1.3 IOC 容器实现

#### BeanFactory：Spring 的核心接口

`BeanFactory` 是 Spring IOC 容器的根接口，定义了 Bean 的获取、类型判断等基本操作：

```java
public interface BeanFactory {
    // 根据名称获取 Bean
    Object getBean(String name) throws BeansException;

    // 根据类型获取 Bean
    <T> T getBean(Class<T> requiredType) throws BeansException;

    // 判断是否包含某个 Bean
    boolean containsBean(String name);

    // 判断是否为单例
    boolean isSingleton(String name) throws NoSuchBeanDefinitionException;
}
```

#### ApplicationContext：BeanFactory 的增强版

`ApplicationContext` 是 `BeanFactory` 的子接口，在企业级应用中更为常用。它不仅提供了 Bean 的管理功能，还扩展了以下能力：

- **国际化支持**：通过 `MessageSource` 接口支持多语言
- **事件发布**：通过 `ApplicationEventPublisher` 发布应用事件
- **资源访问**：通过 `ResourceLoader` 访问文件、URL 等资源
- **AOP 支持**：自动代理 Bean

```java
public interface ApplicationContext extends BeanFactory,
        MessageSource, ApplicationEventPublisher, ResourceLoader {
    // 获取父容器
    ApplicationContext getParent();

    // 获取应用名称
    String getApplicationName();
}
```

#### 三种 ApplicationContext 实现

**1. ClassPathXmlApplicationContext**

从类路径加载 XML 配置文件：

```java
ApplicationContext context = new ClassPathXmlApplicationContext("applicationContext.xml");
UserService userService = context.getBean(UserService.class);
```

对应的 XML 配置：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<beans xmlns="http://www.springframework.org/schema/beans"
       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
       xsi:schemaLocation="http://www.springframework.org/schema/beans
       http://www.springframework.org/schema/beans/spring-beans.xsd">

    <bean id="userDao" class="com.example.dao.UserDaoImpl"/>

    <bean id="userService" class="com.example.service.UserService">
        <constructor-arg ref="userDao"/>
    </bean>
</beans>
```

**2. FileSystemXmlApplicationContext**

从文件系统绝对路径加载 XML 配置文件：

```java
ApplicationContext context = new FileSystemXmlApplicationContext("C:/config/applicationContext.xml");
```

**3. AnnotationConfigApplicationContext**

基于注解配置，是现代 Spring 应用的主流方式：

```java
@Configuration
@ComponentScan(basePackages = "com.example")
public class AppConfig {

    @Bean
    public UserDao userDao() {
        return new UserDaoImpl();
    }

    @Bean
    public UserService userService(UserDao userDao) {
        return new UserService(userDao);
    }
}

// 启动容器
ApplicationContext context = new AnnotationConfigApplicationContext(AppConfig.class);
UserService userService = context.getBean(UserService.class);
```

### 1.4 @Autowired 注入原理

#### AutowiredAnnotationBeanPostProcessor

`@Autowired` 注解的处理由 `AutowiredAnnotationBeanPostProcessor` 负责。这个类实现了 `BeanPostProcessor` 接口，在 Bean 初始化前后进行依赖注入：

```java
public class AutowiredAnnotationBeanPostProcessor
        implements BeanPostProcessor, MergedBeanDefinitionPostProcessor {

    @Override
    public PropertyValues postProcessProperties(PropertyValues pvs, Object bean, String beanName) {
        // 1. 查找需要注入的元数据（字段、方法上的 @Autowired）
        InjectionMetadata metadata = findAutowiringMetadata(beanName, bean.getClass(), pvs);

        try {
            // 2. 执行注入
            metadata.inject(bean, beanName, pvs);
        } catch (BeanCreationException ex) {
            throw ex;
        }
        return pvs;
    }
}
```

#### 按类型注入 vs 按名称注入

默认情况下，`@Autowired` 按类型（byType）注入：

```java
@Autowired
private UserDao userDao; // 容器中查找类型为 UserDao 的 Bean
```

如果存在多个同类型的 Bean，Spring 会按名称（byName）匹配：

```java
@Autowired
private UserDao userDao; // 如果存在多个 UserDao，则查找名为 "userDao" 的 Bean
```

#### @Qualifier / @Primary

当存在多个同类型的 Bean 时，可以使用 `@Qualifier` 明确指定：

```java
@Bean("mysqlUserDao")
public UserDao mysqlUserDao() {
    return new MysqlUserDaoImpl();
}

@Bean("redisUserDao")
public UserDao redisUserDao() {
    return new RedisUserDaoImpl();
}

// 注入时指定
@Autowired
@Qualifier("mysqlUserDao")
private UserDao userDao;
```

或者使用 `@Primary` 标记默认注入的 Bean：

```java
@Primary
@Bean
public UserDao primaryUserDao() {
    return new MysqlUserDaoImpl(); // 默认注入这个
}
```

#### 循环依赖的三级缓存解决方案

循环依赖是指两个或多个 Bean 相互依赖形成闭环：

```java
@Service
public class ServiceA {
    @Autowired
    private ServiceB serviceB;
}

@Service
public class ServiceB {
    @Autowired
    private ServiceA serviceA;
}
```

Spring 通过三级缓存解决 setter/字段注入的循环依赖（构造器循环依赖无法解决），具体原理将在第四章详细讲解。

---

## 二、Bean 的生命周期

### 2.1 Bean 的完整生命周期（12步）

Spring Bean 的生命周期是一个复杂而精细的过程，包含以下 12 个关键步骤：

```
┌─────────────────────────────────────────────────────────────┐
│  1. BeanDefinition 解析                                      │
│  2. BeanDefinition 注册                                      │
│  3. 实例化（构造器/工厂方法）                                  │
│  4. 属性注入（populateBean）                                  │
│  5. Aware 接口回调                                           │
│  6. BeanPostProcessor.postProcessBeforeInitialization       │
│  7. @PostConstruct                                          │
│  8. InitializingBean.afterPropertiesSet                     │
│  9. init-method                                             │
│  10. BeanPostProcessor.postProcessAfterInitialization       │
│  11. 使用 Bean                                               │
│  12. @PreDestroy / DisposableBean / destroy-method          │
└─────────────────────────────────────────────────────────────┘
```

让我们通过代码和源码逐一分析：

#### 步骤 1-2：BeanDefinition 解析与注册

Spring 首先会扫描配置文件或注解，将 Bean 的定义信息封装为 `BeanDefinition` 对象，并注册到容器中：

```java
// 简化的 BeanDefinition 结构
public class BeanDefinition {
    private String beanClassName;      // Bean 的全限定类名
    private String scope;              // 作用域：singleton / prototype
    private boolean lazyInit;          // 是否懒加载
    private List<String> dependsOn;    // 依赖的其他 Bean
    private String initMethodName;     // 初始化方法名
    private String destroyMethodName;  // 销毁方法名
}
```

#### 步骤 3：实例化

Spring 通过反射调用构造器或工厂方法创建 Bean 实例：

```java
// AbstractAutowireCapableBeanFactory 源码简化
protected BeanWrapper createBeanInstance(String beanName, RootBeanDefinition mbd) {
    // 1. 尝试使用工厂方法
    if (mbd.getFactoryMethodName() != null) {
        return instantiateUsingFactoryMethod(beanName, mbd);
    }

    // 2. 尝试使用自动选择的构造器
    Constructor<?>[] ctors = determineConstructorsFromBeanPostProcessors(beanClass, beanName);
    if (ctors != null) {
        return autowireConstructor(beanName, mbd, ctors, null);
    }

    // 3. 使用默认无参构造器
    return instantiateBean(beanName, mbd);
}
```

#### 步骤 4：属性注入（populateBean）

实例化后，Spring 调用 `populateBean` 方法注入依赖：

```java
protected void populateBean(String beanName, RootBeanDefinition mbd, BeanWrapper bw) {
    PropertyValues pvs = mbd.getPropertyValues();

    // 处理 @Autowired 注入
    for (BeanPostProcessor bp : getBeanPostProcessors()) {
        if (bp instanceof InstantiationAwareBeanPostProcessor) {
            pvs = ((InstantiationAwareBeanPostProcessor) bp)
                    .postProcessProperties(pvs, bw.getWrappedInstance(), beanName);
        }
    }

    // 应用属性值
    applyPropertyValues(beanName, mbd, bw, pvs);
}
```

#### 步骤 5：Aware 接口回调

如果 Bean 实现了 `Aware` 接口，Spring 会回调相应的方法：

```java
private void invokeAwareMethods(String beanName, Object bean) {
    if (bean instanceof BeanNameAware) {
        ((BeanNameAware) bean).setBeanName(beanName);
    }
    if (bean instanceof BeanFactoryAware) {
        ((BeanFactoryAware) bean).setBeanFactory(this);
    }
    if (bean instanceof ApplicationContextAware) {
        ((ApplicationContextAware) bean).setApplicationContext(this.applicationContext);
    }
}
```

实战示例：

```java
@Service
public class MyService implements BeanNameAware, ApplicationContextAware {

    private String beanName;
    private ApplicationContext context;

    @Override
    public void setBeanName(String name) {
        this.beanName = name;
        System.out.println("Bean 名称: " + name);
    }

    @Override
    public void setApplicationContext(ApplicationContext ctx) {
        this.context = ctx;
        System.out.println("ApplicationContext 已注入");
    }
}
```

#### 步骤 6：BeanPostProcessor.postProcessBeforeInitialization

这是 Bean 初始化前的拦截点，`ApplicationContextAwareProcessor` 就是在这里处理 `ApplicationContextAware` 的：

```java
public Object postProcessBeforeInitialization(Object bean, String beanName) {
    for (BeanPostProcessor bp : getBeanPostProcessors()) {
        Object result = bp.postProcessBeforeInitialization(bean, beanName);
        if (result == null) {
            return bean;
        }
        bean = result;
    }
    return bean;
}
```

#### 步骤 7：@PostConstruct

`@PostConstruct` 是 JSR-250 规范定义的注解，由 `CommonAnnotationBeanPostProcessor` 处理：

```java
@Service
public class CacheService {

    @PostConstruct
    public void init() {
        System.out.println("初始化缓存...");
        // 加载初始数据到缓存
    }
}
```

#### 步骤 8：InitializingBean.afterPropertiesSet

如果 Bean 实现了 `InitializingBean` 接口，Spring 会调用 `afterPropertiesSet` 方法：

```java
@Service
public class DataSourceService implements InitializingBean {

    @Override
    public void afterPropertiesSet() {
        System.out.println("数据源初始化完成");
        // 执行初始化逻辑
    }
}
```

#### 步骤 9：init-method

可以在配置中指定自定义的初始化方法：

```java
@Bean(initMethod = "customInit")
public MyBean myBean() {
    return new MyBean();
}

public class MyBean {
    public void customInit() {
        System.out.println("自定义初始化方法");
    }
}
```

XML 配置方式：

```xml
<bean id="myBean" class="com.example.MyBean" init-method="customInit"/>
```

#### 步骤 10：BeanPostProcessor.postProcessAfterInitialization

这是 Bean 初始化后的拦截点，**AOP 代理就是在这里生成的**：

```java
public Object postProcessAfterInitialization(Object bean, String beanName) {
    for (BeanPostProcessor bp : getBeanPostProcessors()) {
        Object result = bp.postProcessAfterInitialization(bean, beanName);
        if (result != null) {
            return result; // 可能返回代理对象
        }
    }
    return bean;
}
```

#### 步骤 11：使用 Bean

此时 Bean 已经完全初始化，可以被应用程序使用。

#### 步骤 12：销毁

当容器关闭时，Spring 会按以下顺序执行销毁逻辑：

```java
@Service
public class ResourceService {

    @PreDestroy
    public void cleanup() {
        System.out.println("清理资源...");
    }
}

public class ConnectionPool implements DisposableBean {
    @Override
    public void destroy() {
        System.out.println("关闭连接池...");
    }
}

@Bean(destroyMethod = "close")
public DataSource dataSource() {
    return new HikariDataSource();
}
```

### 2.2 BeanPostProcessor 的作用

`BeanPostProcessor` 是 Spring 提供的强大扩展点，允许我们在 Bean 初始化前后进行自定义处理。

#### AOP 代理在这里生成

`AbstractAutoProxyCreator` 是 AOP 代理创建的核心类：

```java
public abstract class AbstractAutoProxyCreator extends ProxyProcessorSupport
        implements BeanPostProcessor {

    @Override
    public Object postProcessAfterInitialization(Object bean, String beanName) {
        if (bean != null) {
            // 检查是否需要代理
            return wrapIfNecessary(bean, beanName, cacheKey);
        }
        return bean;
    }

    protected Object wrapIfNecessary(Object bean, String beanName, Object cacheKey) {
        // 判断是否需要创建代理
        if (shouldSkip(bean, beanName)) {
            return bean;
        }

        // 获取适用的 Advisor（切面）
        Object[] specificInterceptors = getAdvicesAndAdvisorsForBean(bean, beanName, null);

        if (specificInterceptors != null) {
            // 创建代理对象
            Object proxy = createProxy(bean.getClass(), beanName, specificInterceptors, bean);
            return proxy;
        }

        return bean;
    }
}
```

#### 常用 BeanPostProcessor

1. **AutowiredAnnotationBeanPostProcessor**：处理 `@Autowired` 注入
2. **CommonAnnotationBeanPostProcessor**：处理 `@PostConstruct`、`@PreDestroy`、`@Resource`
3. **ApplicationContextAwareProcessor**：处理 `ApplicationContextAware` 等接口
4. **AbstractAutoProxyCreator**：创建 AOP 代理

### 2.3 Bean 的作用域

Spring 支持多种 Bean 作用域：

| 作用域 | 说明 | 使用场景 |
|--------|------|----------|
| `singleton` | 单例（默认） | 无状态的 Service、DAO |
| `prototype` | 每次请求创建新实例 | 有状态的 Bean |
| `request` | 每个 HTTP 请求一个实例 | Web 应用中的请求上下文 |
| `session` | 每个 HTTP Session 一个实例 | 用户会话数据 |
| `application` | 每个 ServletContext 一个实例 | 全局共享数据 |

配置示例：

```java
@Scope("prototype")
@Service
public class ShoppingCart {
    // 每次注入都会创建新实例
}

@Scope(value = "request", proxyMode = ScopedProxyMode.TARGET_CLASS)
@Component
public class UserContext {
    // 每个 HTTP 请求一个实例
}
```

---

## 三、AOP（面向切面编程）

### 3.1 AOP 核心概念

**AOP（Aspect-Oriented Programming，面向切面编程）** 是 OOP 的补充，用于将横切关注点（如日志、事务、安全）从业务逻辑中分离出来。

#### 核心术语

1. **切面（Aspect）**：横切关注点的模块化实现，包含通知和切点
2. **连接点（JoinPoint）**：程序执行过程中的一个点（如方法调用、异常抛出）
3. **通知（Advice）**：在特定连接点执行的动作（如前置通知、后置通知）
4. **切点（Pointcut）**：匹配连接点的谓词表达式，决定通知在哪些连接点执行
5. **织入（Weaving）**：将切面应用到目标对象，创建代理对象的过程

```java
@Aspect
@Component
public class LoggingAspect {

    // 切点：匹配所有 Service 方法
    @Pointcut("execution(* com.example.service.*.*(..))")
    public void serviceLayer() {}

    // 通知：在方法执行前记录日志
    @Before("serviceLayer()")
    public void logBefore(JoinPoint joinPoint) {
        String methodName = joinPoint.getSignature().getName();
        System.out.println("执行方法: " + methodName);
    }
}
```

### 3.2 Spring AOP 的实现原理

Spring AOP 使用动态代理技术实现，主要有两种方式：

#### JDK 动态代理（接口）

当目标类实现了接口时，Spring 使用 JDK 动态代理：

```java
// 简化的 JDK 动态代理实现
public class JdkDynamicAopProxy implements AopProxy {

    @Override
    public Object getProxy(ClassLoader classLoader) {
        return Proxy.newProxyInstance(
            classLoader,
            target.getClass().getInterfaces(), // 代理接口
            new AopInvocationHandler(target, adviceChain)
        );
    }
}

// 调用处理器
private class AopInvocationHandler implements InvocationHandler {
    @Override
    public Object invoke(Object proxy, Method method, Object[] args) {
        // 1. 执行前置通知
        beforeAdvice.invoke();

        // 2. 执行目标方法
        Object result = method.invoke(target, args);

        // 3. 执行后置通知
        afterAdvice.invoke();

        return result;
    }
}
```

#### CGLIB 代理（类）

当目标类没有实现接口时，Spring 使用 CGLIB 生成子类代理：

```java
// 简化的 CGLIB 代理实现
public class CglibAopProxy implements AopProxy {

    @Override
    public Object getProxy(ClassLoader classLoader) {
        Enhancer enhancer = new Enhancer();
        enhancer.setSuperclass(target.getClass()); // 继承目标类
        enhancer.setCallback(new CglibMethodInvocation(target, adviceChain));
        return enhancer.create();
    }
}

// 方法拦截器
private class CglibMethodInvocation implements MethodInterceptor {
    @Override
    public Object intercept(Object obj, Method method, Object[] args, MethodProxy proxy) {
        // 1. 执行前置通知
        beforeAdvice.invoke();

        // 2. 执行目标方法（通过子类调用父类）
        Object result = proxy.invokeSuper(obj, args);

        // 3. 执行后置通知
        afterAdvice.invoke();

        return result;
    }
}
```

#### 代理选择策略

Spring 在 `DefaultAopProxyFactory` 中决定使用哪种代理：

```java
public class DefaultAopProxyFactory implements AopProxyFactory {

    @Override
    public AopProxy createAopProxy(AdvisedSupport config) {
        // 如果目标类是接口或已经是代理类，使用 JDK 动态代理
        if (config.isInterface() || Proxy.isProxyClass(config.getTargetClass())) {
            return new JdkDynamicAopProxy(config);
        }

        // 否则使用 CGLIB 代理
        return new ObjenesisCglibAopProxy(config);
    }
}
```

**强制使用 CGLIB 代理：**

```java
@EnableAspectJAutoProxy(proxyTargetClass = true) // 强制使用 CGLIB
@Configuration
public class AppConfig {
}
```

### 3.3 通知类型

Spring AOP 提供了 5 种通知类型：

```java
@Aspect
@Component
public class ServiceAspect {

    @Before("execution(* com.example.service.*.*(..))")
    public void before(JoinPoint jp) {
        System.out.println("【前置通知】方法执行前");
    }

    @After("execution(* com.example.service.*.*(..))")
    public void after(JoinPoint jp) {
        System.out.println("【后置通知】方法执行后（无论是否异常）");
    }

    @AfterReturning(pointcut = "execution(* com.example.service.*.*(..))", returning = "result")
    public void afterReturning(JoinPoint jp, Object result) {
        System.out.println("【返回通知】方法正常返回，返回值: " + result);
    }

    @AfterThrowing(pointcut = "execution(* com.example.service.*.*(..))", throwing = "ex")
    public void afterThrowing(JoinPoint jp, Throwable ex) {
        System.out.println("【异常通知】方法抛出异常: " + ex.getMessage());
    }

    @Around("execution(* com.example.service.*.*(..))")
    public Object around(ProceedingJoinPoint pjp) throws Throwable {
        System.out.println("【环绕通知】方法执行前");
        Object result = pjp.proceed(); // 执行目标方法
        System.out.println("【环绕通知】方法执行后");
        return result;
    }
}
```

#### 执行顺序

对于同一个切面中的通知，执行顺序如下：

**正常执行：**
```
@Around 前置部分 → @Before → 目标方法 → @AfterReturning → @After → @Around 后置部分
```

**异常执行：**
```
@Around 前置部分 → @Before → 目标方法 → @AfterThrowing → @After → @Around 异常处理
```

### 3.4 @Transactional 事务原理

#### PlatformTransactionManager

Spring 事务管理的核心接口是 `PlatformTransactionManager`：

```java
public interface PlatformTransactionManager {
    // 获取事务
    TransactionStatus getTransaction(TransactionDefinition definition);

    // 提交事务
    void commit(TransactionStatus status);

    // 回滚事务
    void rollback(TransactionStatus status);
}
```

#### @Transactional 工作流程

当方法被 `@Transactional` 标注时，Spring 会为其创建代理：

```java
// 简化的事务拦截器
public class TransactionInterceptor implements MethodInterceptor {

    @Override
    public Object invoke(MethodInvocation invocation) {
        // 1. 获取事务属性
        TransactionAttribute txAttr = getTransactionAttribute(invocation.getMethod());

        // 2. 获取事务管理器
        PlatformTransactionManager tm = getTransactionManager();

        // 3. 开启事务
        TransactionStatus status = tm.getTransaction(txAttr);

        Object result;
        try {
            // 4. 执行目标方法
            result = invocation.proceed();
        } catch (Throwable ex) {
            // 5. 异常时回滚
            if (txAttr.rollbackOn(ex)) {
                tm.rollback(status);
            } else {
                tm.commit(status);
            }
            throw ex;
        }

        // 6. 正常返回时提交
        tm.commit(status);
        return result;
    }
}
```

#### 事务传播行为（7种）

Spring 定义了 7 种事务传播行为：

| 传播行为 | 说明 | 使用场景 |
|---------|------|----------|
| `REQUIRED` | 如果当前存在事务，则加入；否则创建新事务（默认） | 大多数业务方法 |
| `SUPPORTS` | 如果当前存在事务，则加入；否则以非事务方式执行 | 只读查询 |
| `MANDATORY` | 必须在一个已有事务中运行，否则抛出异常 | 必须在事务中调用的方法 |
| `REQUIRES_NEW` | 总是创建新事务，如果当前存在事务则挂起 | 独立的操作（如审计日志） |
| `NOT_SUPPORTED` | 以非事务方式执行，如果当前存在事务则挂起 | 不需要事务的操作 |
| `NEVER` | 以非事务方式执行，如果当前存在事务则抛出异常 | 明确禁止事务的操作 |
| `NESTED` | 如果当前存在事务，则在嵌套事务中执行；否则等同于 REQUIRED | 批量处理中的子任务 |

```java
@Service
public class OrderService {

    @Transactional(propagation = Propagation.REQUIRED)
    public void createOrder(Order order) {
        // 加入当前事务或创建新事务
        orderDao.save(order);
        inventoryService.deduct(order);
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void logAudit(String operation) {
        // 总是创建新事务，即使外部事务回滚，审计日志也会保存
        auditDao.save(new AuditLog(operation));
    }
}
```

#### 事务隔离级别

```java
@Transactional(isolation = Isolation.READ_COMMITTED)
public void readCommitted() {
    // 只能读取已提交的数据，避免脏读
}

@Transactional(isolation = Isolation.REPEATABLE_READ)
public void repeatableRead() {
    // 可重复读，避免脏读和不可重复读
}
```

#### @Transactional 失效的常见场景

**1. 自调用问题**

```java
@Service
public class UserService {

    public void methodA() {
        // 直接调用 methodB，事务不会生效！
        this.methodB();
    }

    @Transactional
    public void methodB() {
        // 事务配置
    }
}
```

**原因**：`this.methodB()` 是直接调用目标对象的方法，而不是通过代理对象调用。

**解决方案**：
```java
@Autowired
private UserService self; // 注入自身代理

public void methodA() {
    self.methodB(); // 通过代理调用，事务生效
}
```

**2. 非 public 方法**

```java
@Transactional
private void saveUser(User user) {
    // 事务不会生效！Spring AOP 默认只代理 public 方法
}
```

**3. 异常类型不匹配**

```java
@Transactional
public void process() {
    try {
        // 业务逻辑
    } catch (Exception e) {
        // 捕获了异常，事务不会回滚！
    }
}
```

默认情况下，Spring 只对 `RuntimeException` 和 `Error` 回滚。如果需要回滚检查异常：

```java
@Transactional(rollbackFor = Exception.class)
public void process() throws IOException {
    // 现在 IOException 也会触发回滚
}
```

---

## 四、循环依赖与三级缓存

### 4.1 什么是循环依赖

循环依赖是指两个或多个 Bean 之间形成依赖闭环：

```java
@Service
public class ServiceA {
    @Autowired
    private ServiceB serviceB;
}

@Service
public class ServiceB {
    @Autowired
    private ServiceA serviceA;
}
```

#### 构造器循环依赖（无法解决）

```java
@Service
public class ServiceA {
    public ServiceA(ServiceB serviceB) {
        this.serviceB = serviceB;
    }
}

@Service
public class ServiceB {
    public ServiceB(ServiceA serviceA) {
        this.serviceA = serviceA;
    }
}
```

这种情况下，Spring 无法创建任何一个 Bean，会抛出 `BeanCurrentlyInCreationException`。

#### setter / 字段循环依赖（可以解决）

Spring 通过三级缓存机制解决这种循环依赖。

### 4.2 三级缓存机制

Spring 在 `DefaultSingletonBeanRegistry` 中定义了三级缓存：

```java
public class DefaultSingletonBeanRegistry {

    // 一级缓存：存放完全初始化的单例 Bean
    private final Map<String, Object> singletonObjects = new ConcurrentHashMap<>(256);

    // 二级缓存：存放早期暴露的 Bean（已实例化但未完成属性注入）
    private final Map<String, Object> earlySingletonObjects = new ConcurrentHashMap<>(256);

    // 三级缓存：存放 Bean 工厂（用于创建早期暴露的 Bean）
    private final Map<String, ObjectFactory<?>> singletonFactories = new HashMap<>(256);
}
```

#### 创建过程详解

假设 A 依赖 B，B 依赖 A：

**1. 创建 Bean A：**

```java
// 1.1 实例化 A（从三级缓存提前暴露）
Object beanA = createBeanInstance(A.class);

// 放入三级缓存
addSingletonFactory("A", () -> getEarlyBeanReference("A", beanA));

// 1.2 填充 A 的属性（发现依赖 B）
populateBean("A", beanA);
// → 调用 getBean("B")
```

**2. 创建 Bean B：**

```java
// 2.1 实例化 B
Object beanB = createBeanInstance(B.class);
addSingletonFactory("B", () -> getEarlyBeanReference("B", beanB));

// 2.2 填充 B 的属性（发现依赖 A）
populateBean("B", beanB);
// → 调用 getBean("A")
```

**3. 获取 Bean A（从缓存）：**

```java
protected Object getSingleton(String beanName, boolean allowEarlyReference) {
    // 先从一级缓存查找
    Object singletonObject = this.singletonObjects.get(beanName);

    if (singletonObject == null && isSingletonCurrentlyInCreation(beanName)) {
        // 从二级缓存查找
        singletonObject = this.earlySingletonObjects.get(beanName);

        if (singletonObject == null && allowEarlyReference) {
            synchronized (this.singletonObjects) {
                // 双重检查
                singletonObject = this.singletonObjects.get(beanName);
                if (singletonObject == null) {
                    singletonObject = this.earlySingletonObjects.get(beanName);
                    if (singletonObject == null) {
                        // 从三级缓存获取工厂并创建
                        ObjectFactory<?> singletonFactory = this.singletonFactories.get(beanName);
                        if (singletonFactory != null) {
                            singletonObject = singletonFactory.getObject();
                            // 放入二级缓存
                            this.earlySingletonObjects.put(beanName, singletonObject);
                            // 移除三级缓存
                            this.singletonFactories.remove(beanName);
                        }
                    }
                }
            }
        }
    }
    return singletonObject;
}
```

**4. 完成 B 的初始化：**

```java
// B 拿到了 A 的早期引用（可能是代理对象）
populateBean("B", beanB);
initializeBean("B", beanB);

// B 初始化完成，放入一级缓存
addSingleton("B", beanB);
// 移除二级缓存中的 B
this.earlySingletonObjects.remove("B");
this.singletonFactories.remove("B");
```

**5. 完成 A 的初始化：**

```java
// A 拿到了完整的 B
populateBean("A", beanA);
initializeBean("A", beanA);

// A 初始化完成，放入一级缓存
addSingleton("A", beanA);
```

### 4.3 为什么需要三级缓存而不是两级

#### AOP 代理的提前暴露

如果只有两级缓存，当 Bean A 需要被 AOP 代理时，会出现问题：

```java
// 假设只有二级缓存
// 1. A 实例化，放入二级缓存
earlySingletonObjects.put("A", beanA); // 原始对象

// 2. B 依赖 A，从二级缓存获取
Object a = earlySingletonObjects.get("A"); // 拿到的是原始对象

// 3. A 初始化完成后，创建代理对象
Object proxyA = createProxy(beanA);
singletonObjects.put("A", proxyA); // 一级缓存放代理对象

// 问题：B 拿到的是原始对象，而容器中是代理对象，不一致！
```

#### ObjectFactory 的作用

三级缓存通过 `ObjectFactory` 延迟创建代理对象：

```java
// 放入三级缓存时，是工厂而不是对象本身
addSingletonFactory("A", () -> {
    // 如果需要代理，这里返回代理对象
    return getEarlyBeanReference("A", beanA);
});

protected Object getEarlyBeanReference(String beanName, Object bean) {
    // 遍历所有 BeanPostProcessor
    for (BeanPostProcessor bp : getBeanPostProcessors()) {
        if (bp instanceof SmartInstantiationAwareBeanPostProcessor) {
            // AbstractAutoProxyCreator 会在这里创建代理
            bean = ((SmartInstantiationAwareBeanPostProcessor) bp)
                    .getEarlyBeanReference(bean, beanName);
        }
    }
    return bean; // 返回代理对象或原始对象
}
```

**这样设计的好处：**

1. **延迟代理创建**：只有在真正被其他 Bean 依赖时，才创建代理对象
2. **保证一致性**：B 拿到的和容器中存储的是同一个代理对象
3. **避免重复创建**：通过二级缓存缓存已创建的代理对象

---

## 五、Spring MVC 请求处理流程

### 5.1 DispatcherServlet 核心流程

Spring MVC 的核心是 `DispatcherServlet`，它作为前端控制器，协调各个组件处理 HTTP 请求：

```
客户端 → DispatcherServlet → HandlerMapping → Controller → HandlerAdapter
    ↓                                                              ↓
响应 ← View ← ViewResolver ← ModelAndView ←──────────────────────┘
```

#### 详细流程

```java
public class DispatcherServlet extends HttpServlet {

    @Override
    protected void doDispatch(HttpServletRequest request, HttpServletResponse response) {
        HandlerExecutionChain mappedHandler = null;
        ModelAndView mv = null;

        try {
            // 1. 查找处理器（Controller）
            mappedHandler = getHandler(request);
            if (mappedHandler == null) {
                noHandlerFound(request, response);
                return;
            }

            // 2. 查找处理器适配器
            HandlerAdapter ha = getHandlerAdapter(mappedHandler.getHandler());

            // 3. 执行拦截器前置方法
            if (!mappedHandler.applyPreHandle(request, response)) {
                return;
            }

            // 4. 执行控制器方法
            mv = ha.handle(request, response, mappedHandler.getHandler());

            // 5. 执行拦截器后置方法
            mappedHandler.applyPostHandle(request, response, mv);

            // 6. 处理返回结果（视图解析、渲染）
            processDispatchResult(request, response, mappedHandler, mv, null);

        } catch (Exception ex) {
            // 异常处理
            mv = processHandlerException(request, response, mappedHandler, ex);
        }
    }
}
```

#### 步骤详解

**1. 接收请求**

`DispatcherServlet` 接收到 HTTP 请求后，首先进行一些基础处理（如 multipart 解析、locale 解析等）。

**2. HandlerMapping 查找处理器**

```java
protected HandlerExecutionChain getHandler(HttpServletRequest request) {
    for (HandlerMapping hm : this.handlerMappings) {
        HandlerExecutionChain handler = hm.getHandler(request);
        if (handler != null) {
            return handler;
        }
    }
    return null;
}
```

`HandlerMapping` 根据请求 URL 查找对应的 Controller 方法，并将拦截器组装成 `HandlerExecutionChain`。

**3. HandlerAdapter 适配执行**

```java
protected HandlerAdapter getHandlerAdapter(Object handler) {
    for (HandlerAdapter ha : this.handlerAdapters) {
        if (ha.supports(handler)) {
            return ha;
        }
    }
    throw new ServletException("No adapter for handler: " + handler);
}
```

`HandlerAdapter` 负责调用 Controller 方法，处理参数绑定、返回值转换等。

**4. 返回 ModelAndView**

Controller 方法执行后，返回 `ModelAndView` 对象，包含模型数据和视图名称。

**5. ViewResolver 解析视图**

```java
protected View resolveViewName(String viewName, Map<String, Object> model,
                               Locale locale, HttpServletRequest request) {
    for (ViewResolver viewResolver : this.viewResolvers) {
        View view = viewResolver.resolveViewName(viewName, locale);
        if (view != null) {
            return view;
        }
    }
    return null;
}
```

**6. 渲染响应**

`View` 对象将模型数据渲染为 HTML 或其他格式，写入 HTTP 响应。

### 5.2 @RequestMapping 原理

#### RequestMappingHandlerMapping

`@RequestMapping` 的处理由 `RequestMappingHandlerMapping` 负责：

```java
public class RequestMappingHandlerMapping extends AbstractHandlerMethodMapping {

    @Override
    protected void registerHandlerMethod(Object handler, Method method, RequestMappingInfo mapping) {
        // 将 @RequestMapping 的信息注册到映射表中
        // mapping 包含：URL 模式、HTTP 方法、请求参数、请求头等
    }

    @Override
    protected HandlerMethod lookupHandlerMethod(String lookupPath, HttpServletRequest request) {
        // 根据请求 URL 查找匹配的 HandlerMethod
        List<PartialMatch> matches = getMatchingPatterns(lookupPath, request);
        if (matches.isEmpty()) {
            return null;
        }
        // 返回匹配的 Controller 方法
        return matches.get(0).getHandlerMethod();
    }
}
```

#### 参数解析器（HandlerMethodArgumentResolver）

Spring MVC 使用策略模式处理 Controller 方法的参数：

```java
public interface HandlerMethodArgumentResolver {
    // 是否支持该参数类型
    boolean supportsParameter(MethodParameter parameter);

    // 解析参数值
    Object resolveArgument(MethodParameter parameter, ModelAndViewContainer mavContainer,
                          NativeWebRequest webRequest, WebDataBinderFactory binderFactory);
}
```

**常用参数解析器：**

- `RequestParamMethodArgumentResolver`：处理 `@RequestParam`
- `PathVariableMethodArgumentResolver`：处理 `@PathVariable`
- `RequestBodyMethodArgumentResolver`：处理 `@RequestBody`
- `ModelAttributeMethodProcessor`：处理 `@ModelAttribute`

示例：

```java
@RestController
@RequestMapping("/users")
public class UserController {

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        // PathVariableMethodArgumentResolver 解析 id
        return userService.findById(id);
    }

    @PostMapping
    public User createUser(@RequestBody User user) {
        // RequestBodyMethodArgumentResolver 解析 user
        return userService.save(user);
    }

    @GetMapping
    public List<User> search(@RequestParam String name, @RequestParam int age) {
        // RequestParamMethodArgumentResolver 解析参数
        return userService.search(name, age);
    }
}
```

#### 返回值处理器（HandlerMethodReturnValueHandler）

```java
public interface HandlerMethodReturnValueHandler {
    // 是否支持该返回类型
    boolean supportsReturnType(MethodParameter returnType);

    // 处理返回值
    void handleReturnValue(Object returnValue, MethodParameter returnType,
                          ModelAndViewContainer mavContainer, NativeWebRequest webRequest);
}
```

**常用返回值处理器：**

- `ResponseBodyEmitterReturnValueHandler`：处理 `@ResponseBody`
- `ViewMethodReturnValueHandler`：处理 `View` 返回类型
- `ModelAndViewMethodReturnValueHandler`：处理 `ModelAndView`

---

## 六、Spring Boot 自动配置原理

### 6.1 @SpringBootApplication 拆解

`@SpringBootApplication` 是一个组合注解，包含三个核心注解：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Inherited
@SpringBootConfiguration      // 1. 标记为配置类
@EnableAutoConfiguration      // 2. 开启自动配置
@ComponentScan(               // 3. 组件扫描
    excludeFilters = {
        @Filter(type = FilterType.CUSTOM, classes = TypeExcludeFilter.class),
        @Filter(type = FilterType.CUSTOM, classes = AutoConfigurationExcludeFilter.class)
    }
)
public @interface SpringBootApplication {
    // 排除特定的自动配置类
    @AliasFor(annotation = EnableAutoConfiguration.class)
    Class<?>[] exclude() default {};

    // 排除特定的自动配置类名
    @AliasFor(annotation = EnableAutoConfiguration.class)
    String[] excludeName() default {};

    // 扫描的包路径
    @AliasFor(annotation = ComponentScan.class, attribute = "basePackages")
    String[] scanBasePackages() default {};
}
```

#### @SpringBootConfiguration

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Configuration  // 本质上就是 @Configuration
public @interface SpringBootConfiguration {
}
```

#### @EnableAutoConfiguration

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@AutoConfigurationPackage  // 将主配置类所在包注册为自动配置包
@Import(AutoConfigurationImportSelector.class)  // 导入自动配置选择器
public @interface EnableAutoConfiguration {
    String ENABLED_OVERRIDE_PROPERTY = "spring.boot.enableautoconfiguration";

    Class<?>[] exclude() default {};

    String[] excludeName() default {};
}
```

#### @ComponentScan

默认扫描主配置类所在包及其子包：

```java
@SpringBootApplication
public class MyApplication {
    // 自动扫描 com.example 及其子包
}

// 自定义扫描路径
@SpringBootApplication(scanBasePackages = {"com.example", "com.other"})
public class MyApplication {
}
```

### 6.2 自动配置加载流程

#### spring.factories / AutoConfiguration.imports

Spring Boot 2.7 之前，自动配置类通过 `META-INF/spring.factories` 注册：

```properties
# META-INF/spring.factories
org.springframework.boot.autoconfigure.EnableAutoConfiguration=\
com.example.MyAutoConfiguration,\
com.example.AnotherAutoConfiguration
```

Spring Boot 2.7 及之后，推荐使用 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`：

```
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.MyAutoConfiguration
com.example.AnotherAutoConfiguration
```

#### AutoConfigurationImportSelector

```java
public class AutoConfigurationImportSelector implements DeferredImportSelector {

    @Override
    public String[] selectImports(AnnotationMetadata annotationMetadata) {
        // 1. 获取所有自动配置类
        List<String> configurations = getCandidateConfigurations(annotationMetadata, attributes);

        // 2. 去重
        configurations = removeDuplicates(configurations);

        // 3. 排除用户指定的配置类
        Set<String> exclusions = getExclusions(annotationMetadata, attributes);
        configurations.removeAll(exclusions);

        // 4. 排序
        configurations = sort(configurations);

        return configurations.toArray(new String[0]);
    }
}
```

#### @Conditional 系列条件注解

自动配置类通过条件注解控制是否生效：

```java
@Configuration
@ConditionalOnClass(DataSource.class)  // 类路径中存在 DataSource 类时才生效
@ConditionalOnMissingBean(DataSource.class)  // 容器中没有 DataSource Bean 时才生效
public class DataSourceAutoConfiguration {

    @Bean
    @ConditionalOnProperty(prefix = "spring.datasource", name = "url")
    public DataSource dataSource() {
        // 配置了 spring.datasource.url 时才创建
        return new HikariDataSource();
    }
}
```

**常用条件注解：**

| 注解 | 说明 |
|------|------|
| `@ConditionalOnBean` | 容器中存在指定 Bean 时生效 |
| `@ConditionalOnMissingBean` | 容器中不存在指定 Bean 时生效 |
| `@ConditionalOnClass` | 类路径中存在指定类时生效 |
| `@ConditionalOnMissingClass` | 类路径中不存在指定类时生效 |
| `@ConditionalOnProperty` | 指定配置项满足条件时生效 |
| `@ConditionalOnExpression` | SpEL 表达式为 true 时生效 |

#### 配置优先级

自动配置的优先级可以通过 `@AutoConfigureOrder`、`@AutoConfigureBefore`、`@AutoConfigureAfter` 控制：

```java
@Configuration
@AutoConfigureAfter(DataSourceAutoConfiguration.class)
@AutoConfigureBefore(MyBatisAutoConfiguration.class)
public class MyAutoConfiguration {
    // 在 DataSource 之后、MyBatis 之前配置
}
```

### 6.3 Starter 机制

Starter 是 Spring Boot 提供的一种依赖管理机制，通过引入一个 Starter，可以自动引入相关的所有依赖和配置。

#### 自定义 Starter 的步骤

**1. 创建自动配置模块**

```xml
<!-- my-spring-boot-autoconfigure/pom.xml -->
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-autoconfigure</artifactId>
    </dependency>
    <dependency>
        <groupId>com.example</groupId>
        <artifactId>my-service</artifactId>
    </dependency>
</dependencies>
```

**2. 编写自动配置类**

```java
@Configuration
@ConditionalOnClass(MyService.class)
@EnableConfigurationProperties(MyProperties.class)
public class MyAutoConfiguration {

    @Bean
    @ConditionalOnMissingBean
    public MyService myService(MyProperties properties) {
        return new MyService(properties.getUrl());
    }
}

@ConfigurationProperties(prefix = "my.service")
public class MyProperties {
    private String url = "http://localhost:8080";

    // getters and setters
}
```

**3. 注册自动配置**

```
# META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
com.example.MyAutoConfiguration
```

**4. 创建 Starter 模块**

```xml
<!-- my-spring-boot-starter/pom.xml -->
<dependencies>
    <dependency>
        <groupId>com.example</groupId>
        <artifactId>my-spring-boot-autoconfigure</artifactId>
        <version>1.0.0</version>
    </dependency>
</dependencies>
```

**5. 使用 Starter**

```xml
<dependency>
    <groupId>com.example</groupId>
    <artifactId>my-spring-boot-starter</artifactId>
    <version>1.0.0</version>
</dependency>
```

```yaml
# application.yml
my:
  service:
    url: http://api.example.com
```

---

## 七、Spring 面试题精选

### 1. 什么是 Spring IOC 容器？它的作用是什么？

**解答：**

Spring IOC（Inversion of Control，控制反转）容器是 Spring 框架的核心组件，负责管理 Bean 的生命周期和依赖关系。它的主要作用包括：

1. **对象创建与管理**：根据配置（XML、注解或 Java Config）创建 Bean 实例
2. **依赖注入**：自动将 Bean 的依赖注入到目标对象中
3. **生命周期管理**：调用初始化方法、销毁方法，管理 Bean 的完整生命周期
4. **AOP 支持**：为 Bean 创建代理，实现切面编程

核心接口是 `BeanFactory` 和 `ApplicationContext`，后者提供了更多企业级功能（国际化、事件发布、资源访问等）。

### 2. @Autowired 和 @Resource 有什么区别？

**解答：**

| 特性 | @Autowired | @Resource |
|------|-----------|-----------|
| 来源 | Spring 框架 | JSR-250 规范 |
| 注入方式 | 默认按类型（byType） | 默认按名称（byName） |
| 指定名称 | 配合 @Qualifier | 使用 name 属性 |
| 必需性 | required 属性 | 无此属性 |

```java
// @Autowired 按类型，多个时用 @Qualifier 指定
@Autowired
@Qualifier("userService")
private UserService userService;

// @Resource 直接按名称
@Resource(name = "userService")
private UserService userService;
```

### 3. Spring Bean 的作用域有哪些？默认是哪个？

**解答：**

Spring 支持 5 种作用域：

1. **singleton**（默认）：整个容器只有一个实例
2. **prototype**：每次请求创建新实例
3. **request**：每个 HTTP 请求一个实例
4. **session**：每个 HTTP Session 一个实例
5. **application**：每个 ServletContext 一个实例

```java
@Scope("prototype")
@Service
public class ShoppingCart { }
```

### 4. Spring 如何解决循环依赖？

**解答：**

Spring 通过三级缓存解决 setter/字段注入的循环依赖：

1. **一级缓存（singletonObjects）**：存放完全初始化的 Bean
2. **二级缓存（earlySingletonObjects）**：存放早期暴露的 Bean
3. **三级缓存（singletonFactories）**：存放 Bean 工厂

流程：A 实例化 → 暴露工厂到三级缓存 → A 依赖 B → B 实例化 → B 依赖 A → 从三级缓存获取 A 的早期引用 → B 初始化完成 → A 初始化完成。

构造器循环依赖无法解决，因为 Bean 还未实例化就无法暴露到缓存。

### 5. Spring AOP 的实现原理是什么？JDK 动态代理和 CGLIB 有什么区别？

**解答：**

Spring AOP 使用动态代理实现：

- **JDK 动态代理**：目标类必须实现接口，通过 `Proxy.newProxyInstance()` 创建代理
- **CGLIB 代理**：目标类无需实现接口，通过继承生成子类代理

Spring 默认策略：有接口用 JDK 代理，无接口用 CGLIB。可通过 `@EnableAspectJAutoProxy(proxyTargetClass = true)` 强制使用 CGLIB。

### 6. @Transactional 在什么情况下会失效？

**解答：**

常见失效场景：

1. **自调用**：同一个类中方法调用，未经过代理
2. **非 public 方法**：Spring AOP 默认只代理 public 方法
3. **异常被捕获**：异常被 try-catch 吞掉，事务管理器无法感知
4. **异常类型不匹配**：默认只回滚 RuntimeException，检查异常需要 `rollbackFor = Exception.class`
5. **数据库引擎不支持**：如 MySQL 的 MyISAM 引擎不支持事务

### 7. Spring MVC 的请求处理流程是怎样的？

**解答：**

1. 客户端发送请求到 `DispatcherServlet`
2. `DispatcherServlet` 调用 `HandlerMapping` 查找处理器
3. 返回 `HandlerExecutionChain`（包含 Controller 和拦截器）
4. `HandlerAdapter` 适配并执行 Controller 方法
5. 返回 `ModelAndView`（或 @ResponseBody 直接写响应）
6. `ViewResolver` 解析视图
7. 渲染视图并返回响应

### 8. Spring Boot 自动配置的原理是什么？

**解答：**

`@SpringBootApplication` 包含 `@EnableAutoConfiguration`，该注解通过 `@Import(AutoConfigurationImportSelector.class)` 导入自动配置选择器。

`AutoConfigurationImportSelector` 会扫描 `META-INF/spring.factories` 或 `AutoConfiguration.imports` 文件，加载所有自动配置类。这些配置类通过 `@Conditional` 系列注解控制是否生效（如 `@ConditionalOnClass`、`@ConditionalOnMissingBean`）。

### 9. Spring 中的 Bean 是线程安全的吗？

**解答：**

Spring Bean 本身不保证线程安全，取决于 Bean 的作用域和实现：

- **singleton Bean**：默认单例，如果包含可变状态（成员变量），则不是线程安全的
- **prototype Bean**：每次创建新实例，线程安全

**保证线程安全的方式：**

1. 将 Bean 设计为无状态（不保存可变数据）
2. 使用 `@Scope("prototype")`
3. 使用 `ThreadLocal` 保存线程私有数据
4. 使用同步机制（synchronized、Lock）

### 10. Spring 事件机制是如何工作的？

**解答：**

Spring 提供了基于观察者模式的事件发布/订阅机制：

**定义事件：**
```java
public class UserRegisteredEvent extends ApplicationEvent {
    private final User user;

    public UserRegisteredEvent(Object source, User user) {
        super(source);
        this.user = user;
    }
}
```

**发布事件：**
```java
@Service
public class UserService {
    @Autowired
    private ApplicationEventPublisher publisher;

    public void register(User user) {
        // 业务逻辑
        publisher.publishEvent(new UserRegisteredEvent(this, user));
    }
}
```

**监听事件：**
```java
@Component
public class UserRegisteredListener {
    @EventListener
    public void handleUserRegistered(UserRegisteredEvent event) {
        System.out.println("用户注册: " + event.getUser());
    }
}
```

Spring 容器本身也会发布事件，如 `ContextRefreshedEvent`（容器刷新完成）、`ContextClosedEvent`（容器关闭）。

---

## 总结

Spring 框架的核心原理可以概括为以下几个关键点：

1. **IOC（控制反转）**：将对象的创建和管理权交给 Spring 容器，通过依赖注入实现解耦
2. **Bean 生命周期**：Spring 通过 12 个步骤精细管理 Bean 的创建、初始化、使用和销毁
3. **AOP（面向切面编程）**：通过动态代理技术，将横切关注点从业务逻辑中分离
4. **三级缓存**：巧妙解决循环依赖问题，同时支持 AOP 代理的提前暴露
5. **Spring MVC**：以 DispatcherServlet 为核心，协调各组件处理 HTTP 请求
6. **Spring Boot 自动配置**：通过条件注解和 Starter 机制，实现"约定优于配置"

理解这些核心原理，不仅能帮助我们在面试中脱颖而出，更重要的是能让我们在日常开发中更好地使用 Spring，写出更优雅、更健壮的代码。当我们遇到问题时，能够从原理层面分析原因，而不是盲目地搜索和试错。

Spring 的设计哲学是"简单的事情简单做，复杂的事情可能做"。它为我们提供了简洁的 API 和丰富的功能，让我们能够专注于业务逻辑，而不必重复造轮子。希望本文能帮助你深入理解 Spring 的核心原理，在 Java 开发的道路上走得更远。
