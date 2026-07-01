# Java 设计模式实战——从原理到框架中的应用

## 引言

### 设计模式的本质

设计模式（Design Pattern）并不是什么高深莫测的理论，它是**前人在大量软件开发实践中总结出来的、针对特定问题的可复用解决方案**。你可以把它理解为编程世界的"成语"——每一个模式都浓缩了一种经过验证的、解决某类问题的最佳实践。

1994年，Erich Gamma、Richard Helm、Ralph Johnson、John Vlissides 四位作者合著了经典著作《Design Patterns: Elements of Reusable Object-Oriented Software》，书中系统地整理了 23 种经典设计模式，这四位作者也被合称为 **GoF（Gang of Four）**。

### GoF 23种设计模式分类

GoF 将 23 种设计模式按**用途**分为三大类：

| 分类 | 关注点 | 包含模式 |
|------|--------|----------|
| **创建型（Creational）** | 怎样创建对象 | 单例、工厂方法、抽象工厂、建造者、原型 |
| **结构型（Structural）** | 怎样组合类和对象形成更大结构 | 代理、装饰器、适配器、桥接、外观、组合、享元 |
| **行为型（Behavioral）** | 对象之间怎样分配职责和通信 | 观察者、策略、模板方法、责任链、迭代器、状态、命令、解释器、中介者、备忘录、访问者 |

### 学习设计模式的正确姿势

很多人学习设计模式时，喜欢死记硬背类图和代码，结果到了项目中反而不知道怎么用。正确的学习方式是：

1. **先理解问题场景**：这个模式解决什么痛点？
2. **再理解核心思想**：它的设计哲学是什么？
3. **看框架中的应用**：JDK、Spring、MyBatis 这些成熟框架是怎么用的？
4. **在自己的代码中实践**：遇到类似问题时尝试套用。

> 记住：模式不是银弹，不要为了用模式而用模式。当你的代码出现了大量的 if-else、对象创建逻辑重复、类之间的耦合越来越紧时——这才是模式登场的时刻。

---

## 二、设计原则（SOLID + 其他）

设计模式是"术"，设计原则才是"道"。所有设计模式都是围绕这些原则展开的。

### 2.1 单一职责原则（SRP — Single Responsibility Principle）

> 一个类应该只有一个引起它变化的原因。

换句话说，**一个类只负责一件事**。如果一个类承担的职责过多，当某个职责变化时，修改这个类可能会影响到其他职责。

```java
// ❌ 反面示例：User 类同时负责业务逻辑和持久化
public class User {
    private String name;
    private String email;

    public void saveToDatabase() {
        Connection conn = DriverManager.getConnection(url, user, pass);
        PreparedStatement stmt = conn.prepareStatement("INSERT INTO ...");
        stmt.execute();
    }

    public void sendWelcomeEmail() {
        // 发送邮件的逻辑...
    }
}

// ✅ 正面示例：职责分离
public class User {
    private String name;
    private String email;
    // 纯粹的数据 + 业务方法
}

public class UserRepository {
    public void save(User user) { /* 持久化逻辑 */ }
}

public class EmailService {
    public void sendWelcome(User user) { /* 邮件逻辑 */ }
}
```

### 2.2 开闭原则（OCP — Open-Closed Principle）

> 对扩展开放，对修改关闭。

这是设计模式中**最核心的原则**。几乎所有的模式都在追求：当需求变化时，我们不需要修改原有代码，而是通过添加新代码来扩展功能。

```java
// ❌ 每次新增折扣类型都要修改这个方法
public double calculateDiscount(Order order, String discountType) {
    if ("VIP".equals(discountType)) {
        return order.getTotal() * 0.8;
    } else if ("NEW_USER".equals(discountType)) {
        return order.getTotal() * 0.9;
    }
    // 新增"双11"折扣？又要改这里...
    return order.getTotal();
}

// ✅ 用策略模式 + 开闭原则
public interface DiscountStrategy {
    double apply(double total);
}

public class VipDiscount implements DiscountStrategy {
    public double apply(double total) { return total * 0.8; }
}

public class NewUserDiscount implements DiscountStrategy {
    public double apply(double total) { return total * 0.9; }
}

// 新增双11折扣？加一个类即可，无需修改已有代码
public class Double11Discount implements DiscountStrategy {
    public double apply(double total) { return total * 0.5; }
}
```

### 2.3 里氏替换原则（LSP — Liskov Substitution Principle）

> 所有引用父类的地方必须能透明地使用其子类的对象。

简单来说，**子类不能改变父类原有的行为契约**。如果子类覆盖了父类的方法却改变了语义，那么在运行时替换就会产生意想不到的问题。

```java
// ❌ 经典反例：正方形继承矩形
public class Rectangle {
    protected int width, height;
    public void setWidth(int w) { this.width = w; }
    public void setHeight(int h) { this.height = h; }
    public int getArea() { return width * height; }
}

public class Square extends Rectangle {
    // 正方形宽高相等——但这破坏了父类的行为契约
    @Override
    public void setWidth(int w) { this.width = w; this.height = w; }
    @Override
    public void setHeight(int h) { this.width = h; this.height = h; }
}

// 客户端代码假设宽高可以独立设置
public void testArea(Rectangle r) {
    r.setWidth(5);
    r.setHeight(4);
    assert r.getArea() == 20; // 如果传入 Square，area = 16，测试失败！
}
```

### 2.4 接口隔离原则（ISP — Interface Segregation Principle）

> 客户端不应该依赖它不需要的接口。

把庞大臃肿的接口拆分成多个细粒度的接口，让客户端只依赖自己需要的方法。

```java
// ❌ 臃肿的接口
public interface Worker {
    void work();
    void eat();
    void sleep();
}

// Robot 被迫实现不需要的方法
public class Robot implements Worker {
    public void work() { /* 工作 */ }
    public void eat() { throw new UnsupportedOperationException(); } // 机器人不用吃饭
    public void sleep() { throw new UnsupportedOperationException(); } // 机器人不用睡觉
}

// ✅ 拆分接口
public interface Workable { void work(); }
public interface Eatable { void eat(); }
public interface Sleepable { void sleep(); }

// 机器人只需要 Workable
public class Robot implements Workable {
    public void work() { /* 工作 */ }
}

// 人类需要全部
public class Human implements Workable, Eatable, Sleepable {
    public void work() { /* 工作 */ }
    public void eat() { /* 吃饭 */ }
    public void sleep() { /* 睡觉 */ }
}
```

### 2.5 依赖倒置原则（DIP — Dependency Inversion Principle）

> 高层模块不应该依赖低层模块，二者都应该依赖抽象；抽象不应该依赖细节，细节应该依赖抽象。

这是 Spring IOC 容器存在的理论基石。

```java
// ❌ 高层直接依赖低层实现
public class OrderService {
    private MySQLOrderDAO dao = new MySQLOrderDAO(); // 硬编码依赖
    public void createOrder(Order order) {
        dao.insert(order);
    }
}

// ✅ 依赖抽象
public class OrderService {
    private final OrderRepository repository; // 依赖接口

    // 通过构造函数注入——这就是 Spring 在做的事情
    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }
}

public interface OrderRepository {
    void insert(Order order);
}

public class MySQLOrderRepository implements OrderRepository { ... }
public class MongoOrderRepository implements OrderRepository { ... }
```

### 2.6 迪米特法则（LoD — Law of Demeter）

> 一个对象应该对其他对象有最少的了解，只与直接朋友通信。

也称为"最少知识原则"。不要通过一个对象去调用另一个对象内部对象的方法。

```java
// ❌ 违反迪米特法则：客户端需要了解 Department -> Manager -> Name 的链路
String managerName = department.getManager().getName();

// ✅ 让 Department 封装好内部细节
String managerName = department.getManagerName();
```

---

## 三、创建型模式

创建型模式关注**如何优雅地创建对象**，将创建逻辑与使用逻辑解耦。

### 3.1 单例模式（Singleton）

单例模式保证一个类在 JVM 中**只有一个实例**，并提供全局访问点。这是面试最高频的设计模式，也是 Spring 框架的默认 Bean 作用域。

#### 饿汉式（线程安全）

```java
public class SingletonEager {
    // 类加载时就创建实例，由类加载机制保证线程安全
    private static final SingletonEager INSTANCE = new SingletonEager();

    private SingletonEager() {} // 私有构造函数

    public static SingletonEager getInstance() {
        return INSTANCE;
    }
}
```

**优点**：简单、线程安全。**缺点**：无论是否使用都会占用内存。

#### 懒汉式（DCL 双重检查锁 + volatile）

```java
public class SingletonDCL {
    // 必须加 volatile！防止指令重排序导致拿到半初始化对象
    private static volatile SingletonDCL instance;

    private SingletonDCL() {}

    public static SingletonDCL getInstance() {
        if (instance == null) {                    // 第一次检查：避免不必要的加锁
            synchronized (SingletonDCL.class) {
                if (instance == null) {             // 第二次检查：防止重复创建
                    instance = new SingletonDCL();
                }
            }
        }
        return instance;
    }
}
```

**为什么需要 volatile？** 因为 `instance = new SingletonDCL()` 在字节码层面包含三步：①分配内存 ②调用构造函数 ③引用赋值。没有 volatile 的话，步骤 ②③ 可能被重排序，导致其他线程拿到一个未初始化的对象。

#### 静态内部类

```java
public class SingletonHolder {
    private SingletonHolder() {}

    // 利用类加载机制保证线程安全，只有调用 getInstance() 才会加载内部类
    private static class Holder {
        private static final SingletonHolder INSTANCE = new SingletonHolder();
    }

    public static SingletonHolder getInstance() {
        return Holder.INSTANCE;
    }
}
```

#### 枚举（推荐方式）

```java
public enum SingletonEnum {
    INSTANCE;

    public void doSomething() {
        System.out.println("Doing work...");
    }
}

// 使用：SingletonEnum.INSTANCE.doSomething();
```

**为什么推荐枚举？** Effective Java 作者 Josh Bloch 明确推荐。枚举天然防止了三种破坏单例的方式：反射攻击、序列化反序列化、克隆。

#### 破坏单例的方式

```java
// 1. 反射破坏
Constructor<SingletonDCL> constructor = SingletonDCL.class.getDeclaredConstructor();
constructor.setAccessible(true);
SingletonDCL another = constructor.newInstance(); // 得到一个新实例！

// 枚举可以防止：
Constructor<SingletonEnum> enumCtor = SingletonEnum.class.getDeclaredConstructor();
// 抛出 IllegalArgumentException: Cannot reflectively create enum objects

// 2. 序列化破坏（实现 Serializable 的类）
SingletonDCL original = SingletonDCL.getInstance();
// 序列化后再反序列化，得到的是不同对象
// 解决方法：添加 readResolve() 方法返回 INSTANCE

// 3. 克隆破坏（实现 Cloneable 的类）
// 解决方法：重写 clone() 方法返回 INSTANCE
```

#### 框架中的单例

```java
// JDK 中的单例
Runtime runtime = Runtime.getRuntime(); // JVM 运行时环境

// Spring 中的单例（注意：Spring 的单例是容器级别的，不是 JVM 级别的）
// 默认 scope="singleton"，同一个 Bean 在容器中只有一个实例
@Component
public class UserService {
    // Spring 容器保证全局只有一个 UserService 实例
}
```

### 3.2 工厂方法模式（Factory Method）

#### 简单工厂 vs 工厂方法

```java
// 简单工厂（不属于 GoF 23种，但非常实用）
public class PaymentFactory {
    public static Payment create(String type) {
        switch (type) {
            case "ALIPAY": return new AliPay();
            case "WECHAT": return new WechatPay();
            default: throw new IllegalArgumentException("Unknown type: " + type);
        }
    }
}

// 工厂方法：每种产品对应一个工厂（符合开闭原则）
public interface PaymentFactory {
    Payment create();
}

public class AliPayFactory implements PaymentFactory {
    public Payment create() { return new AliPay(); }
}

public class WechatPayFactory implements PaymentFactory {
    public Payment create() { return new WechatPay(); }
}
```

#### 抽象工厂

当需要创建**一族相关产品**时，使用抽象工厂：

```java
public interface GUIFactory {
    Button createButton();
    TextField createTextField();
}

public class WindowsFactory implements GUIFactory {
    public Button createButton() { return new WindowsButton(); }
    public TextField createTextField() { return new WindowsTextField(); }
}

public class MacFactory implements GUIFactory {
    public Button createButton() { return new MacButton(); }
    public TextField createTextField() { return new MacTextField(); }
}
```

#### Spring 中的 FactoryBean

Spring 的 `FactoryBean` 是一个特殊的 Bean，它本身是一个工厂，Spring 容器会调用其 `getObject()` 方法获取真正的 Bean 实例：

```java
public class MybatisMapperFactoryBean implements FactoryBean<Object> {
    private Class<?> mapperInterface;

    @Override
    public Object getObject() throws Exception {
        // MyBatis 通过动态代理生成 Mapper 接口的实现
        return Proxy.newProxyInstance(
            mapperInterface.getClassLoader(),
            new Class[]{mapperInterface},
            new MapperProxy(sqlSession)
        );
    }

    @Override
    public Class<?> getObjectType() { return mapperInterface; }
}
```

### 3.3 建造者模式（Builder）

当一个对象的构造参数非常多时，用 Builder 模式比用一长串构造函数参数要优雅得多。

```java
public class HttpRequest {
    private final String url;
    private final String method;
    private final Map<String, String> headers;
    private final String body;
    private final int timeout;

    private HttpRequest(Builder builder) {
        this.url = builder.url;
        this.method = builder.method;
        this.headers = builder.headers;
        this.body = builder.body;
        this.timeout = builder.timeout;
    }

    public static class Builder {
        private final String url;       // 必填参数
        private String method = "GET";  // 默认值
        private Map<String, String> headers = new HashMap<>();
        private String body;
        private int timeout = 30000;

        public Builder(String url) {
            this.url = url;
        }

        public Builder method(String method) { this.method = method; return this; }
        public Builder header(String key, String value) { headers.put(key, value); return this; }
        public Builder body(String body) { this.body = body; return this; }
        public Builder timeout(int timeout) { this.timeout = timeout; return this; }

        public HttpRequest build() {
            return new HttpRequest(this);
        }
    }
}

// 使用——链式调用，清晰明了
HttpRequest request = new HttpRequest.Builder("https://api.example.com/users")
    .method("POST")
    .header("Content-Type", "application/json")
    .body("{\"name\":\"张三\"}")
    .timeout(5000)
    .build();
```

**Lombok @Builder**：实际项目中，直接用 Lombok 的 `@Builder` 注解即可自动生成 Builder 代码。

```java
@Builder
public class User {
    private String name;
    private int age;
    private String email;
}

// 使用
User user = User.builder()
    .name("张三")
    .age(25)
    .email("zhangsan@example.com")
    .build();
```

**JDK 中的建造者**：`StringBuilder` 就是一个经典的 Builder 模式实现——通过 `append()` 链式添加内容，最终 `toString()` 构建结果。`Stream.Builder`、`OkHttpClient.Builder` 也是同样的思想。

### 3.4 原型模式（Prototype）

通过复制已有对象来创建新对象，而不是重新 new。

```java
public class Document implements Cloneable {
    private String title;
    private List<String> paragraphs; // 引用类型

    @Override
    public Document clone() {
        try {
            Document cloned = (Document) super.clone();
            // 深拷贝：对引用类型也要克隆
            cloned.paragraphs = new ArrayList<>(this.paragraphs);
            return cloned;
        } catch (CloneNotSupportedException e) {
            throw new RuntimeException(e);
        }
    }
}
```

**深拷贝 vs 浅拷贝**：`super.clone()` 默认是浅拷贝——基本类型会复制值，引用类型只复制引用（指向同一个对象）。如果需要深拷贝，必须对每个引用类型字段也进行克隆。另一种实现深拷贝的方式是**序列化/反序列化**。

**Spring 的 prototype scope**：Spring 中 `<bean scope="prototype">` 表示每次从容器获取该 Bean 时都会创建一个新实例——这和原型模式思想一致，但实现方式是容器重新调用构造方法创建。

---

## 四、结构型模式

结构型模式关注**如何将类和对象组合成更大的结构**，同时保持结构的灵活性。

### 4.1 代理模式（Proxy）—— 最重要的结构型模式

代理模式是 Java 生态中**最重要、最常用**的设计模式，没有之一。Spring AOP、MyBatis Mapper、RPC 框架底层全是代理。

#### 静态代理

```java
public interface UserService {
    void save(User user);
}

// 被代理对象（真实角色）
public class UserServiceImpl implements UserService {
    public void save(User user) {
        System.out.println("保存用户: " + user.getName());
    }
}

// 代理对象
public class UserServiceProxy implements UserService {
    private final UserService target;

    public UserServiceProxy(UserService target) {
        this.target = target;
    }

    @Override
    public void save(User user) {
        System.out.println("开启事务...");    // 前置增强
        target.save(user);                   // 调用真实方法
        System.out.println("提交事务...");    // 后置增强
    }
}
```

**静态代理的问题**：每个接口都需要写一个代理类，接口多了就爆炸。

#### JDK 动态代理

JDK 动态代理通过 `Proxy` 类和 `InvocationHandler` 接口，**在运行时动态生成代理类**，无需手动编写代理类。

```java
public class TransactionHandler implements InvocationHandler {
    private final Object target;

    public TransactionHandler(Object target) {
        this.target = target;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        System.out.println("开启事务...");
        Object result = method.invoke(target, args); // 反射调用目标方法
        System.out.println("提交事务...");
        return result;
    }
}

// 创建代理
UserService userService = new UserServiceImpl();
UserService proxy = (UserService) Proxy.newProxyInstance(
    userService.getClass().getClassLoader(),
    userService.getClass().getInterfaces(),
    new TransactionHandler(userService)
);

proxy.save(new User("张三")); // 自动织入事务逻辑
```

**核心原理**：JDK 动态代理在运行时生成一个 `$Proxy0` 类，它继承了 `Proxy` 并实现了目标接口。所有方法调用都会被转发到 `InvocationHandler.invoke()`。

**限制**：目标类必须实现接口。

#### CGLIB 代理

当目标类没有实现接口时，JDK 动态代理就无能为力了。CGLIB 通过**生成目标类的子类**来实现代理：

```java
public class CglibProxy implements MethodInterceptor {
    @Override
    public Object intercept(Object obj, Method method, Object[] args,
                            MethodProxy proxy) throws Throwable {
        System.out.println("前置增强...");
        Object result = proxy.invokeSuper(obj, args); // 调用父类方法
        System.out.println("后置增强...");
        return result;
    }
}

// 使用
Enhancer enhancer = new Enhancer();
enhancer.setSuperclass(UserServiceImpl.class);
enhancer.setCallback(new CglibProxy());
UserServiceImpl proxy = (UserServiceImpl) enhancer.create();
proxy.save(new User("张三"));
```

#### 框架中的代理应用

```java
// Spring AOP：自动选择代理策略
// 目标类实现了接口 → JDK 动态代理
// 目标类没有实现接口 → CGLIB 代理
// Spring Boot 2.x 默认使用 CGLIB 代理

// MyBatis Mapper：通过 JDK 动态代理生成 Mapper 接口的实现
// MapperProxy 实现了 InvocationHandler
// 在 invoke() 中解析 SQL 注解或 XML 映射，执行数据库操作

// RPC 框架（Dubbo、gRPC）：客户端调用远程服务就像调用本地方法
// 底层通过动态代理将方法名、参数序列化后通过网络发送
```

### 4.2 装饰器模式（Decorator）

装饰器模式**动态地给对象添加额外功能**，比继承更灵活。

```java
public interface DataSource {
    void write(String data);
    String read();
}

public class FileDataSource implements DataSource {
    private String filename;
    public FileDataSource(String filename) { this.filename = filename; }
    public void write(String data) { /* 写文件 */ }
    public String read() { /* 读文件 */ return "file content"; }
}

// 装饰器基类
public abstract class DataSourceDecorator implements DataSource {
    protected DataSource wrappee;
    public DataSourceDecorator(DataSource source) { this.wrappee = source; }
}

public class EncryptionDecorator extends DataSourceDecorator {
    public EncryptionDecorator(DataSource source) { super(source); }
    public void write(String data) {
        wrappee.write(encrypt(data)); // 先加密，再写
    }
    public String read() {
        return decrypt(wrappee.read()); // 先读，再解密
    }
}

public class CompressionDecorator extends DataSourceDecorator {
    public CompressionDecorator(DataSource source) { super(source); }
    public void write(String data) { wrappee.write(compress(data)); }
    public String read() { return decompress(wrappee.read()); }
}

// 自由组合装饰器
DataSource source = new CompressionDecorator(
    new EncryptionDecorator(
        new FileDataSource("data.txt")
    )
);
source.write("Hello World"); // 先加密 → 再压缩 → 写文件
```

**与代理模式的区别**：
- **代理模式**：关注控制访问，增强行为通常与业务无关（事务、日志、权限）
- **装饰器模式**：关注增强功能，为对象添加新的职责（加密、压缩、缓存）

**Java IO 流的装饰器体系**：

```java
// Java IO 是装饰器模式的教科书级应用
BufferedReader reader = new BufferedReader(     // 缓冲能力
    new InputStreamReader(                       // 字节→字符转换
        new FileInputStream("file.txt")           // 基础文件读取
    )
);

// 可以自由组合
BufferedInputStream bis = new BufferedInputStream(
    new GZIPInputStream(                         // 解压能力
        new FileInputStream("data.gz")
    )
);
```

### 4.3 适配器模式（Adapter）

适配器模式将一个类的接口转换成客户端期望的另一个接口，**让原本接口不兼容的类可以协同工作**。

```java
// 目标接口
public interface Target {
    void request();
}

// 被适配的类（接口不兼容）
public class Adaptee {
    public void specificRequest() {
        System.out.println("Adaptee specific request");
    }
}

// 对象适配器（推荐，组合优于继承）
public class Adapter implements Target {
    private final Adaptee adaptee;

    public Adapter(Adaptee adaptee) {
        this.adaptee = adaptee;
    }

    @Override
    public void request() {
        adaptee.specificRequest(); // 转换调用
    }
}
```

**Java 中的适配器**：

```java
// InputStreamReader：字节流 → 字符流的适配器
// Reader 是目标接口，InputStream 是被适配者
InputStreamReader reader = new InputStreamReader(System.in); // System.in 是字节流

// Spring MVC 的 HandlerAdapter
// DispatcherServlet 通过 HandlerAdapter 适配不同类型的处理器
// Controller → SimpleControllerHandlerAdapter
// @RequestMapping → RequestMappingHandlerAdapter
// HttpRequestHandler → HttpRequestHandlerAdapter
```

### 4.4 桥接模式（Bridge）

桥接模式将**抽象部分与实现部分分离**，使它们可以独立变化。

```java
// 实现接口
public interface Color {
    void fill();
}

public class Red implements Color {
    public void fill() { System.out.println("填充红色"); }
}

public class Blue implements Color {
    public void fill() { System.out.println("填充蓝色"); }
}

// 抽象部分，通过组合持有实现
public abstract class Shape {
    protected Color color; // 桥接：聚合而非继承

    public Shape(Color color) { this.color = color; }
    public abstract void draw();
}

public class Circle extends Shape {
    public Circle(Color color) { super(color); }
    public void draw() {
        System.out.print("画圆形，");
        color.fill();
    }
}

// 使用：抽象和实现可以独立扩展
Shape redCircle = new Circle(new Red());   // 画圆形，填充红色
Shape blueCircle = new Circle(new Blue()); // 画圆形，填充蓝色
```

**JDBC 中的桥接设计**：`java.sql.Driver` 是接口（实现侧），`DriverManager` 是抽象侧。不同数据库（MySQL、Oracle、PostgreSQL）各自实现 Driver 接口，而客户端代码通过 `DriverManager` 统一调用，不需要关心底层驱动的具体实现。这就是桥接模式的经典应用。

### 4.5 外观模式（Facade）

外观模式为复杂子系统提供一个**统一的简化接口**。

```java
// 复杂的子系统
public class OrderService { void createOrder() { ... } }
public class PaymentService { void pay() { ... } }
public class InventoryService { void deductStock() { ... } }
public class NotificationService { void sendNotification() { ... } }

// 外观类：简化客户端调用
public class ShoppingFacade {
    private final OrderService orderService;
    private final PaymentService paymentService;
    private final InventoryService inventoryService;
    private final NotificationService notificationService;

    public void checkout(Order order) {
        orderService.createOrder();
        inventoryService.deductStock();
        paymentService.pay();
        notificationService.sendNotification();
        // 客户端只需调用 checkout()，不需要知道内部4个子系统的协作
    }
}
```

**SLF4J 日志门面**：SLF4J（Simple Logging Facade for Java）是外观模式的典型应用。它提供了一个统一的日志 API 外观，底层可以接入 Logback、Log4j2、java.util.logging 等任何日志实现：

```java
// 客户端只依赖 SLF4J 的外观接口
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

Logger log = LoggerFactory.getLogger(MyClass.class);
log.info("处理订单: {}", orderId); // 底层具体用 Logback 还是 Log4j2？客户端不关心
```

---

## 五、行为型模式

行为型模式关注**对象之间的职责分配和通信方式**。

### 5.1 观察者模式（Observer）

观察者模式定义了对象之间的**一对多依赖关系**，当一个对象状态改变时，所有依赖者自动收到通知。

```java
// 自定义实现
public interface EventListener {
    void onEvent(String eventType, Object data);
}

public class EventBus {
    private Map<String, List<EventListener>> listeners = new HashMap<>();

    public void subscribe(String eventType, EventListener listener) {
        listeners.computeIfAbsent(eventType, k -> new ArrayList<>()).add(listener);
    }

    public void publish(String eventType, Object data) {
        listeners.getOrDefault(eventType, Collections.emptyList())
            .forEach(l -> l.onEvent(eventType, data));
    }
}

// 使用
EventBus bus = new EventBus();
bus.subscribe("ORDER_CREATED", (type, data) -> System.out.println("发短信: " + data));
bus.subscribe("ORDER_CREATED", (type, data) -> System.out.println("发邮件: " + data));
bus.publish("ORDER_CREATED", "订单#12345");
```

#### Spring 的事件机制

Spring 内置了完善的观察者模式实现：

```java
// 定义事件
public class OrderCreatedEvent extends ApplicationEvent {
    private final Order order;
    public OrderCreatedEvent(Object source, Order order) {
        super(source);
        this.order = order;
    }
    public Order getOrder() { return order; }
}

// 发布事件
@Service
public class OrderService {
    @Autowired
    private ApplicationEventPublisher publisher;

    public void createOrder(Order order) {
        // ... 业务逻辑
        publisher.publishEvent(new OrderCreatedEvent(this, order));
    }
}

// 监听事件（注解方式，Spring 4.2+）
@Component
public class OrderNotificationListener {
    @EventListener
    public void handleOrderCreated(OrderCreatedEvent event) {
        System.out.println("发送通知: " + event.getOrder().getId());
    }
}

@Component
public class OrderInventoryListener {
    @Async // 异步监听
    @EventListener
    public void handleOrderCreated(OrderCreatedEvent event) {
        System.out.println("扣减库存: " + event.getOrder().getId());
    }
}
```

**发布-订阅 vs 观察者**：观察者模式中，观察者和被观察者是直接耦合的（被观察者持有观察者引用）；发布-订阅模式通过**中间的消息代理/事件总线**解耦了发布者和订阅者。Spring 的事件机制更接近发布-订阅模式。

### 5.2 策略模式（Strategy）

策略模式定义一系列算法，将每个算法封装成独立的类，使它们可以互相替换。**它是消除 if-else/switch 的利器**。

```java
// 策略接口
public interface PayStrategy {
    boolean pay(BigDecimal amount);
}

// 具体策略
@Component("aliPay")
public class AliPayStrategy implements PayStrategy {
    public boolean pay(BigDecimal amount) {
        System.out.println("支付宝支付: " + amount);
        return true;
    }
}

@Component("wechatPay")
public class WechatPayStrategy implements PayStrategy {
    public boolean pay(BigDecimal amount) {
        System.out.println("微信支付: " + amount);
        return true;
    }
}

// 策略上下文 + 工厂（结合 Spring 自动注入）
@Service
public class PaymentService {
    private final Map<String, PayStrategy> strategyMap;

    // Spring 会自动将所有 PayStrategy 实现按 beanName 注入到 Map 中
    @Autowired
    public PaymentService(Map<String, PayStrategy> strategyMap) {
        this.strategyMap = strategyMap;
    }

    public boolean pay(String payType, BigDecimal amount) {
        PayStrategy strategy = strategyMap.get(payType);
        if (strategy == null) throw new IllegalArgumentException("不支持的支付方式: " + payType);
        return strategy.pay(amount);
    }
}
```

**JDK 中的策略模式**：`Comparator` 就是经典的策略模式。不同的排序策略可以灵活替换：

```java
List<String> names = Arrays.asList("Charlie", "Alice", "Bob");

// 不同策略
names.sort(Comparator.naturalOrder());           // 自然排序
names.sort(Comparator.reverseOrder());            // 逆序
names.sort(Comparator.comparingInt(String::length)); // 按长度排序

// Java 8 lambda 让策略模式更加简洁
names.sort((a, b) -> a.length() - b.length());
```

### 5.3 模板方法模式（Template Method）

模板方法模式在**父类中定义算法骨架**，将某些步骤延迟到子类实现。它用到了 Java 的继承机制。

```java
public abstract class AbstractExporter {
    // 模板方法：定义算法骨架（final 防止子类篡改流程）
    public final void export(List<Data> dataList) {
        validate(dataList);
        List<Row> rows = transform(dataList);  // 子类实现
        byte[] bytes = serialize(rows);         // 子类实现
        writeToFile(bytes);
    }

    protected void validate(List<Data> dataList) {
        if (dataList == null || dataList.isEmpty())
            throw new IllegalArgumentException("数据不能为空");
    }

    // 抽象步骤
    protected abstract List<Row> transform(List<Data> dataList);
    protected abstract byte[] serialize(List<Row> rows);

    private void writeToFile(byte[] bytes) { /* 写文件 */ }
}

public class ExcelExporter extends AbstractExporter {
    protected List<Row> transform(List<Data> dataList) { /* 转为 Excel 行 */ return null; }
    protected byte[] serialize(List<Row> rows) { /* 序列化为 xlsx */ return null; }
}

public class CsvExporter extends AbstractExporter {
    protected List<Row> transform(List<Data> dataList) { /* 转为 CSV 行 */ return null; }
    protected byte[] serialize(List<Row> rows) { /* 序列化为 CSV */ return null; }
}
```

#### HttpServlet 的模板方法

`HttpServlet.service()` 方法就是模板方法——它根据请求方法（GET/POST/PUT...）分发到 `doGet()`、`doPost()` 等方法，开发者只需重写对应的 do 方法：

```java
// HttpServlet 源码（简化）
protected void service(HttpServletRequest req, HttpServletResponse resp) {
    String method = req.getMethod();
    if (method.equals("GET")) {
        doGet(req, resp);
    } else if (method.equals("POST")) {
        doPost(req, resp);
    }
    // ...
}
```

#### Spring 中的模板方法

Spring 大量使用模板方法模式，并以 `xxxTemplate` 命名：

```java
// JdbcTemplate：封装了 JDBC 操作的固定流程
jdbcTemplate.query("SELECT * FROM users WHERE age > ?",
    new Object[]{18},
    (rs, rowNum) -> new User(rs.getString("name"), rs.getInt("age"))
);
// 固定流程：获取连接 → 创建Statement → 执行 → 处理结果集 → 关闭资源
// 开发者只需提供 SQL 和 RowMapper（结果映射策略）

// RestTemplate：封装 HTTP 请求的固定流程
String result = restTemplate.getForObject("https://api.example.com/data", String.class);
// 固定流程：创建请求 → 发送 → 接收响应 → 转换 → 关闭连接
```

### 5.4 责任链模式（Chain of Responsibility）

责任链模式让请求沿着一系列处理者传递，每个处理者决定是处理还是传递给下一个。**它实现了请求发送者与处理者的解耦**。

```java
// 责任链节点
public abstract class Handler {
    protected Handler next;

    public void setNext(Handler next) { this.next = next; }

    public void handle(Request request) {
        if (canHandle(request)) {
            doHandle(request);
        } else if (next != null) {
            next.handle(request);
        }
    }

    protected abstract boolean canHandle(Request request);
    protected abstract void doHandle(Request request);
}

// 具体处理者
public class AuthHandler extends Handler {
    protected boolean canHandle(Request r) { return r.needsAuth(); }
    protected void doHandle(Request r) { /* 鉴权 */ }
}

public class RateLimitHandler extends Handler {
    protected boolean canHandle(Request r) { return true; }
    protected void doHandle(Request r) { /* 限流 */ }
}
```

#### Servlet Filter 链

```java
// Servlet Filter 是责任链模式的经典应用
public class LoggingFilter implements Filter {
    public void doFilter(ServletRequest req, ServletResponse resp, FilterChain chain) {
        System.out.println("请求到达: " + req.getRequestURI()); // 前置处理
        chain.doFilter(req, resp);  // 传递给链中的下一个 Filter
        System.out.println("请求结束");                        // 后置处理
    }
}
```

#### Spring Interceptor 链

```java
public class AuthInterceptor implements HandlerInterceptor {
    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse resp, Object handler) {
        // 前置处理：检查 Token
        String token = req.getHeader("Authorization");
        return token != null; // 返回 false 则中断链
    }

    @Override
    public void postHandle(HttpServletRequest req, HttpServletResponse resp,
                           Object handler, ModelAndView mav) {
        // 后置处理
    }
}
```

#### Netty Pipeline

Netty 的 `ChannelPipeline` 是责任链模式的高级应用——每个 `ChannelHandler` 可以处理入站事件或出站事件，形成一个双向责任链：

```java
pipeline.addLast(new HttpServerCodec());        // HTTP 编解码
pipeline.addLast(new HttpObjectAggregator(65536)); // 聚合 HTTP 消息
pipeline.addLast(new MyBusinessHandler());       // 业务处理
```

### 5.5 迭代器模式（Iterator）

迭代器模式提供一种方法**顺序访问集合中的元素，而不暴露其内部结构**。

```java
// Java 集合框架中的迭代器
List<String> list = Arrays.asList("A", "B", "C");
Iterator<String> it = list.iterator();
while (it.hasNext()) {
    System.out.println(it.next());
}

// 增强 for 循环底层就是迭代器
for (String s : list) {
    System.out.println(s);
}
```

**内部迭代 vs 外部迭代**：

```java
// 外部迭代：客户端控制遍历过程（Iterator）
Iterator<String> it = list.iterator();
while (it.hasNext()) {
    String s = it.next();
    if (s.length() > 3) System.out.println(s);
}

// 内部迭代：集合自己控制遍历过程（Stream API，Java 8+）
list.stream()
    .filter(s -> s.length() > 3)
    .forEach(System.out::println);

// 内部迭代的优势：
// 1. 代码更简洁
// 2. 可以并行化（parallelStream）
// 3. 可以延迟求值（lazy evaluation）
list.parallelStream()  // 并行遍历！外部迭代很难做到
    .filter(s -> s.length() > 3)
    .map(String::toUpperCase)
    .collect(Collectors.toList());
```

---

## 六、设计模式在 Spring 中的综合应用

Spring 框架之所以经典，很大程度上在于它对设计模式的精妙运用。理解 Spring 的设计，需要综合运用前面讲到的各种模式。

### IOC（控制反转）：工厂方法 + 单例 + 依赖倒置

```java
// Spring IOC 容器本质上是一个大工厂
// BeanFactory 是工厂方法的抽象
// ApplicationContext 是其最常用的实现
// 默认每个 Bean 都是单例的（容器级别）
// 依赖倒置：Bean 不直接 new 依赖，而是由容器注入

ApplicationContext ctx = new AnnotationConfigApplicationContext(AppConfig.class);
UserService userService = ctx.getBean(UserService.class); // 工厂方法获取
```

### AOP（面向切面编程）：代理 + 装饰器 + 策略

```java
// Spring AOP 的实现融合了多个设计模式：
// 1. 代理模式：JDK 动态代理 / CGLIB 生成代理对象
// 2. 装饰器模式：给目标对象"装饰"上事务、日志、缓存等功能
// 3. 策略模式：不同的 Advice（BeforeAdvice、AfterAdvice、AroundAdvice）

@Aspect
@Component
public class LogAspect {
    @Around("execution(* com.example.service.*.*(..))")
    public Object log(ProceedingJoinPoint pjp) throws Throwable {
        long start = System.currentTimeMillis();
        Object result = pjp.proceed(); // 执行目标方法
        long cost = System.currentTimeMillis() - start;
        log.info("方法 {} 耗时 {}ms", pjp.getSignature(), cost);
        return result;
    }
}
```

### BeanPostProcessor：观察者 + 模板方法

`BeanPostProcessor` 是 Spring 容器最强大的扩展点之一。它在 Bean 初始化前后提供回调，AOP 代理就是在这里创建的：

```java
// AbstractAutowireCapableBeanFactory 中的模板方法
// initializeBean() 定义了 Bean 初始化的骨架流程：
// 1. 调用 BeanPostProcessor.postProcessBeforeInitialization()
// 2. 调用 init-method
// 3. 调用 BeanPostProcessor.postProcessAfterInitialization()  ← AOP代理在这里创建
```

### Spring MVC：前端控制器 + 适配器 + 策略

```java
// DispatcherServlet 是前端控制器模式
// 它内部组合了多个策略接口：
// - HandlerMapping：请求 → Handler 的映射策略
// - HandlerAdapter：适配不同类型的 Handler
// - ViewResolver：视图解析策略
// - HandlerExceptionResolver：异常处理策略

// 请求处理流程：
// 1. HandlerMapping 找到匹配的 Handler
// 2. HandlerAdapter 适配并执行 Handler
// 3. ViewResolver 解析视图
// 4. 渲染响应
```

---

## 七、面试高频设计模式题

### 1. 手写单例（5种写法）

面试官通常期望你能写出 DCL（双重检查锁）、静态内部类、枚举三种方式，并能解释 volatile 的作用和反射破坏的防御方法。

```java
// 面试推荐写法：枚举（一行解决所有问题）
public enum Singleton {
    INSTANCE;
}

// 或者静态内部类（展示对类加载机制的理解）
public class Singleton {
    private Singleton() {}
    private static class Holder {
        static final Singleton INSTANCE = new Singleton();
    }
    public static Singleton getInstance() { return Holder.INSTANCE; }
}
```

### 2. JDK 动态代理实现

```java
// 面试常见：手写一个简单的动态代理
Object proxy = Proxy.newProxyInstance(
    target.getClass().getClassLoader(),
    target.getClass().getInterfaces(),
    (p, method, args) -> {
        System.out.println("Before: " + method.getName());
        Object result = method.invoke(target, args);
        System.out.println("After: " + method.getName());
        return result;
    }
);
```

关键追问：JDK 动态代理为什么要求目标类必须实现接口？因为 JDK 生成的代理类继承了 `java.lang.reflect.Proxy`，Java 不支持多继承，所以只能实现接口。

### 3. 用策略模式重构业务代码

面试中常给出一段充满 if-else 的业务代码，要求用策略模式重构。核心思路：

1. 提取公共接口
2. 每种条件分支变成一个策略实现类
3. 用 Map + 工厂（或 Spring 自动注入）消除 if-else

### 4. 设计模式在项目中如何应用

面试回答模板：

> "在我们项目的支付模块中，原来有大量 if-else 判断不同支付渠道。我用**策略模式**重构了它：定义 PayStrategy 接口，每种支付渠道一个实现类，结合 Spring 的 Map 自动注入，新增支付渠道只需添加一个类，完全符合开闭原则。在订单模块中，我用**观察者模式**（Spring 事件机制）解耦了订单创建后的通知、库存、积分等逻辑，避免了 OrderService 变得臃肿。"

---

## 总结

设计模式不是教条，而是经验。本文覆盖了实际开发和面试中最核心的设计模式，总结如下：

**六大设计原则**（SOLID + 迪米特）是所有模式的理论基石，其中**开闭原则**最为核心——几乎所有模式的目标都是让系统"对扩展开放、对修改关闭"。

**创建型模式**中，单例模式是面试高频考点（掌握 5 种写法 + 破坏方式），工厂方法在实际项目中使用最广泛，建造者模式在参数众多的场景下大幅提升代码可读性。

**结构型模式**中，代理模式是 Java 生态最重要的模式，JDK 动态代理和 CGLIB 是 Spring AOP、MyBatis、RPC 等框架的基石。装饰器模式在 Java IO 体系中大放异彩。

**行为型模式**中，策略模式是消除 if-else 的首选方案，观察者模式（Spring 事件机制）实现了业务解耦，模板方法模式在 Spring 的各种 `xxxTemplate` 中无处不在，责任链模式是 Filter/Interceptor/Pipeline 的核心设计。

**在 Spring 中的综合应用**：IOC = 工厂方法 + 单例 + 依赖倒置；AOP = 代理 + 装饰器 + 策略；Spring MVC = 前端控制器 + 适配器 + 策略。Spring 框架本身就是一本最好的设计模式教科书。

最后，**不要为了用模式而用模式**。当你发现代码中出现了重复的对象创建、越来越多的 if-else、类之间的强耦合、难以测试的依赖关系时——翻开这篇文章，找到对应的模式，让它自然地解决你的问题。这才是学习设计模式的正确姿势。
