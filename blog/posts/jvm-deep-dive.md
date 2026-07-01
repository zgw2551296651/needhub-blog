# JVM 深度解析——内存模型、垃圾回收与性能调优

## 引言

Java 虚拟机（JVM）是 Java 生态系统的基石。自 1995 年 Sun Microsystems 发布 Java 以来，"Write Once, Run Anywhere" 的跨平台承诺正是由 JVM 实现的。JVM 不仅仅是一个字节码解释器，它是一个高度复杂的运行时环境，包含类加载机制、内存管理、垃圾回收、即时编译（JIT）等核心子系统。

**为什么要深入理解 JVM？**

对于初级开发者而言，JVM 是一个黑盒——代码放进去就能运行。但对于中高级工程师，理解 JVM 内部机制至关重要：

- **性能调优**：线上系统出现 Full GC 频繁、响应延迟飙升、内存泄漏等问题时，只有深入 JVM 才能精准定位。
- **架构设计**：合理的内存规划、GC 策略选择直接影响系统的吞吐量和可用性。
- **技术面试**：JVM 相关知识是互联网大厂面试的必考领域，覆盖类加载、内存模型、GC 算法等核心考点。
- **故障排查**：OOM、死锁、线程泄漏等生产事故的根因分析离不开 JVM 诊断工具。

本文将从架构、内存、GC、调优四个维度，结合源码级别的细节和实战案例，对 JVM 进行全面深入的剖析。

---

## 一、JVM 架构概览

JVM 的整体架构可以概括为三大子系统：

```
┌──────────────────────────────────────────────────────────────┐
│                        JVM 架构                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  类加载子系统    │  │ 运行时数据区  │  │  执行引擎     │  │
│  │                 │  │              │  │               │  │
│  │  .class 文件    │  │  堆/栈/方法区 │  │  解释器       │  │
│  │       ↓         │  │  程序计数器   │  │  JIT 编译器   │  │
│  │  加载→验证→准备 │  │  本地方法栈   │  │  GC          │  │
│  │  →解析→初始化   │  │              │  │               │  │
│  └─────────────────┘  └──────────────┘  └───────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │            本地方法接口 (JNI)                          │   │
│  │            本地方法库 (.dll / .so)                     │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 类加载子系统

类加载子系统负责将 `.class` 文件加载到 JVM 中，并在方法区（JDK 8+ 为元空间 Metaspace）中创建对应的 `java.lang.Class` 对象。整个过程分为五个阶段：

**加载（Loading）**

读取 `.class` 文件的字节流，按照 JVM 规范解析其结构，在方法区生成该类的运行时数据结构，并在堆中生成一个代表该类的 `Class` 对象。字节流的来源可以是：
- 本地文件系统（`.class` 文件）
- JAR / WAR 包
- 网络（HTTP、FTP）
- 动态生成（CGLIB、ASM 字节码增强）

**验证（Verification）**

确保字节码符合 JVM 规范，不会危害虚拟机安全。包括四个子阶段：

| 验证阶段 | 内容 | 示例 |
|---------|------|------|
| 文件格式验证 | 魔数、版本号、常量池合法性 | 魔数必须为 `0xCAFEBABE` |
| 元数据验证 | 类的继承关系、接口实现合法性 | 是否继承了 `final` 类 |
| 字节码验证 | 指令序列的语义合法性 | 跳转指令是否跳到合法位置 |
| 符号引用验证 | 符号引用能否正确解析为直接引用 | 引用的类是否存在 |

> 可通过 `-XX:+UseSplitVerifier`（JDK 7+）将元数据验证与字节码验证分离。JDK 8 中此参数已默认启用。对于已验证过的类库可使用 `-Xverify:none` 跳过验证以加速启动。

**准备（Preparation）**

为类的静态变量分配内存并设置零值。注意：
- `static int value = 123;` 在准备阶段 `value` 被赋值为 `0`，赋值 `123` 发生在初始化阶段。
- `static final int VALUE = 123;` 编译期常量，准备阶段直接赋值 `123`。

**解析（Resolution）**

将常量池中的符号引用替换为直接引用。符号引用是一组描述目标的符号（如类名、方法签名），直接引用是指向目标的指针、偏移量或句柄。解析动作主要针对：
- 类或接口
- 字段
- 类方法
- 接口方法
- 方法类型、方法句柄

**初始化（Initialization）**

执行类的静态初始化块和静态变量赋值语句。这是类加载的最后一步，也是真正执行 Java 代码的第一步。

**类加载器层次与双亲委派模型**

```
┌─────────────────────────────────────────┐
│         Bootstrap ClassLoader            │  ← rt.jar, java.*
│         (C++ 实现，null)                 │
├─────────────────────────────────────────┤
│         Extension ClassLoader            │  ← ext/*.jar
│         (sun.misc.Launcher$ExtClassLoader)│
├─────────────────────────────────────────┤
│         Application ClassLoader          │  ← classpath
│         (sun.misc.Launcher$AppClassLoader)│
├─────────────────────────────────────────┤
│         Custom ClassLoader               │  ← 自定义
└─────────────────────────────────────────┘
```

**双亲委派模型**的核心逻辑（`java.lang.ClassLoader#loadClass`）：

```java
protected Class<?> loadClass(String name, boolean resolve)
    throws ClassNotFoundException {
    synchronized (getClassLoadingLock(name)) {
        // 1. 检查是否已加载
        Class<?> c = findLoadedClass(name);
        if (c == null) {
            long t0 = System.nanoTime();
            try {
                if (parent != null) {
                    // 2. 委派父加载器
                    c = parent.loadClass(name, false);
                } else {
                    // 3. 委派 Bootstrap
                    c = findBootstrapClassOrNull(name);
                }
            } catch (ClassNotFoundException e) {
                // 父加载器无法加载，由自己加载
            }
            if (c == null) {
                long t1 = System.nanoTime();
                // 4. 自行加载
                c = findClass(name);
                sun.misc.PerfCounter.getParentDelegationTime().addTime(t1 - t0);
                sun.misc.PerfCounter.getFindClassTime().addElapsedTimeFrom(t1);
                sun.misc.PerfCounter.getFindClasses().increment();
            }
        }
        if (resolve) {
            resolveClass(c);
        }
        return c;
    }
}
```

**打破双亲委派的经典场景：**

| 场景 | 原因 | 实现方式 |
|------|------|---------|
| SPI 机制 | `java.sql.Driver` 在 rt.jar，但实现在第三方 jar | 线程上下文类加载器（`Thread.setContextClassLoader`） |
| Tomcat | 不同 Web 应用需隔离加载各自的类 | 自定义 `WebAppClassLoader`，每个应用独立 |
| OSGi | 模块化热部署，版本隔离 | 网状委派模型，模块间显式导出/导入 |
| 热修复/热部署 | 同一类名的新版本需替换旧版本 | 每次热部署创建新的 ClassLoader 实例 |

### 1.2 运行时数据区

JVM 运行时数据区分为线程私有和线程共享两大类别：

```
┌────────────────────────────────────────────────────────────────┐
│                     JVM 运行时数据区                            │
├────────────────────────┬───────────────────────────────────────┤
│     线程私有            │          线程共享                      │
├────────────────────────┼───────────────────────────────────────┤
│                        │                                       │
│  ┌──────────────────┐ │  ┌─────────────────────────────────┐ │
│  │  程序计数器 (PC)  │ │  │           堆 (Heap)             │ │
│  │  当前字节码行号   │ │  │  ┌─────────┐  ┌─────────────┐ │ │
│  └──────────────────┘ │  │  │ 新生代   │  │   老年代     │ │ │
│                        │  │  │Eden|S0|S1│  │             │ │ │
│  ┌──────────────────┐ │  │  └─────────┘  └─────────────┘ │ │
│  │  虚拟机栈         │ │  └─────────────────────────────────┘ │
│  │  ┌────────────┐  │ │                                       │
│  │  │ 栈帧       │  │ │  ┌─────────────────────────────────┐ │
│  │  │ ┌────────┐ │  │ │  │      方法区 (Metaspace)         │ │
│  │  │ │局部变量表│ │  │ │  │  类信息、常量、静态变量         │ │
│  │  │ │操作数栈 │ │  │ │  │  (JDK 8+ 使用本地内存)         │ │
│  │  │ │动态链接 │ │  │ │  └─────────────────────────────────┘ │
│  │  │ │返回地址 │ │  │                                       │
│  │  │ └────────┘ │  │ │  ┌─────────────────────────────────┐ │
│  │  └────────────┘  │ │  │      运行时常量池                │ │
│  └──────────────────┘ │  │  (方法区的一部分)                 │ │
│                        │  └─────────────────────────────────┘ │
│  ┌──────────────────┐ │                                       │
│  │  本地方法栈       │ │                                       │
│  │  (Native 方法)   │ │                                       │
│  └──────────────────┘ │                                       │
└────────────────────────┴───────────────────────────────────────┘
```

**程序计数器（PC Register）**

- 唯一不会发生 OOM 的区域
- 记录当前线程执行的字节码行号指示器
- 线程切换后能恢复到正确的执行位置

**虚拟机栈（VM Stack）**

- 每个方法调用创建一个栈帧（Stack Frame）
- 栈帧包含：局部变量表、操作数栈、动态链接、方法返回地址
- `-Xss` 设置线程栈大小（默认一般为 1MB）
- OOM 场景：`StackOverflowError`（递归过深）或 `OutOfMemoryError`（无法创建新线程）

```java
// StackOverflowError 示例
public class StackOverflowDemo {
    private static int depth = 0;

    public static void recursive() {
        depth++;
        recursive(); // 无限递归，栈帧耗尽
    }

    public static void main(String[] args) {
        try {
            recursive();
        } catch (StackOverflowError e) {
            System.out.println("栈溢出，递归深度: " + depth);
            // 输出示例：栈溢出，递归深度: 11420
        }
    }
}
```

**本地方法栈（Native Method Stack）**

- 为 `native` 方法服务，结构与虚拟机栈类似
- HotSpot 将本地方法栈和虚拟机栈合二为一

**堆（Heap）**

- JVM 管理的最大内存区域，几乎所有对象实例在此分配
- `-Xms` 初始堆大小，`-Xmx` 最大堆大小
- 垃圾回收的核心区域（详见第二章）
- OOM 场景：`java.lang.OutOfMemoryError: Java heap space`

**方法区（Method Area / Metaspace）**

- JDK 7 及以前：永久代（PermGen），受 `-XX:MaxPermSize` 限制
- JDK 8+：元空间（Metaspace），使用本地内存（Native Memory），受 `-XX:MaxMetaspaceSize` 限制
- 存储：类信息、常量池、静态变量、JIT 编译后的代码
- OOM 场景：`java.lang.OutOfMemoryError: Metaspace`（动态生成大量代理类时常见）

---

## 二、堆内存详解

### 2.1 新生代与老年代

堆内存按照分代收集理论被划分为新生代（Young Generation）和老年代（Old Generation），比例默认为 1:2。

```
┌──────────────────────────────────────────────────────────────┐
│                        堆 (Heap)                             │
│                                                              │
│  ┌─────────────── 新生代 (1/3) ──────────────┐  ┌─ 老年代 (2/3) ─┐ │
│  │                                            │  │                │ │
│  │  ┌──── Eden (80%) ────┐ ┌ S0 (10%)┐ ┌ S1┐│  │  长期存活对象  │ │
│  │  │                    │ │         │ │   ││  │                │ │
│  │  │  新对象优先分配     │ │ From    │ │ To││  │  缓存池/常量   │ │
│  │  │  TLAB 分配          │ │         │ │   ││  │                │ │
│  │  └────────────────────┘ └─────────┘ └───┘│  │                │ │
│  └────────────────────────────────────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**对象分配策略：**

1. **TLAB（Thread Local Allocation Buffer）优先分配**：每个线程在 Eden 区拥有一小块私有缓冲区（默认 1024KB，由 `-XX:TLABSize` 控制）。TLAB 分配无需加锁，极大提升了对象分配效率。当 TLAB 用尽时退化到 Eden 区的 CAS + 失败重试分配。
   - `-XX:+UseTLAB`：启用 TLAB（默认开启）
   - `-XX:TLABSize`：TLAB 大小
   - `-XX:-ResizeTLAB`：禁用 TLAB 自动调整

2. **年龄晋升机制**：对象每经过一次 Minor GC 且仍然存活，年龄 +1。当年龄达到 `-XX:MaxTenuringThreshold`（默认 15）时晋升老年代。但还有两条"快速通道"：
   - **动态年龄判定**：Survivor 区中相同年龄的对象总大小超过 Survivor 空间的一半时，年龄 >= 该年龄的对象直接晋升。
   - **Survivor 空间不足**：Minor GC 后存活对象无法放入 Survivor 区时，通过空间分配担保（Handle Promotion）直接进入老年代。

3. **大对象直接分配老年代**：超过 `-XX:PretenureSizeThreshold`（仅 Serial/ParNew 有效）的对象直接在老年代分配，避免在 Eden 和 Survivor 之间来回复制。

```
对象生命周期示意：

new Object() ──→ Eden
                  │
          [Minor GC 存活]
                  │
                  ▼
              Survivor (S0/S1 来回复制)
                  │
          [年龄 >= MaxTenuringThreshold]
          [或动态年龄判定]
          [或 Survivor 空间不足]
                  │
                  ▼
              老年代 (Old Gen)
                  │
          [Major GC / Full GC]
                  │
                  ▼
              回收 or 长期驻留
```

### 2.2 对象内存布局

HotSpot 虚拟机中，一个 Java 对象在堆内存中的布局分为三部分：

```
┌────────────────────────────────────────────────┐
│                 对象内存布局                    │
├────────────────────────────────────────────────┤
│                                                │
│  ┌──── 对象头 (Object Header) ─────────────┐  │
│  │                                          │  │
│  │  Mark Word (64位 JVM = 8 bytes)         │  │
│  │  ┌──────────────────────────────────────┐│  │
│  │  │ unused:25 | hash:31 | unused:1 | age:4││  │
│  │  │ biased_lock:1 | lock:2               ││  │
│  │  └──────────────────────────────────────┘│  │
│  │                                          │  │
│  │  类型指针 (Klass Pointer)                │  │
│  │  压缩: 4 bytes / 非压缩: 8 bytes        │  │
│  │                                          │  │
│  │  [数组长度] (仅数组对象, 4 bytes)        │  │
│  │                                          │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ┌──── 实例数据 (Instance Data) ───────────┐  │
│  │  父类 + 本类的字段值                      │  │
│  │  long/double: 8 bytes                    │  │
│  │  int/float: 4 bytes                      │  │
│  │  short/char: 2 bytes                     │  │
│  │  byte/boolean: 1 byte                    │  │
│  │  引用: 压缩 4 bytes / 非压缩 8 bytes     │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  ┌──── 对齐填充 (Padding) ─────────────────┐  │
│  │  补齐到 8 bytes 的整数倍                  │  │
│  └──────────────────────────────────────────┘  │
│                                                │
└────────────────────────────────────────────────┘
```

**Mark Word 详解（64 位 JVM，非 GC 状态）：**

| 锁状态 | 存储内容 | 标志位 |
|--------|---------|--------|
| 无锁（未偏向） | hashCode (31bit) + 分代年龄 (4bit) + 0 + 01 | `0 01` |
| 偏向锁 | 线程ID (54bit) + epoch (2bit) + 分代年龄 (4bit) + 1 + 01 | `1 01` |
| 轻量级锁 | 指向栈中锁记录的指针 (62bit) + 00 | `00` |
| 重量级锁 | 指向互斥量（Monitor）的指针 (62bit) + 10 | `10` |
| GC 标记 | 空 (62bit) + 11 | `11` |

可通过 JOL（Java Object Layout）工具查看实际对象布局：

```java
// 引入依赖: org.openjdk.jol:jol-core:0.16
import org.openjdk.jol.info.ClassLayout;

public class ObjectLayoutDemo {
    static class Sample {
        int a;       // 4 bytes
        long b;      // 8 bytes
        boolean c;   // 1 byte
        Object d;    // 引用 4 bytes (压缩)
    }

    public static void main(String[] args) {
        System.out.println(ClassLayout.parseClass(Sample.class).toPrintable());
    }
}

/* 输出示例（64位 JVM，开启压缩指针）：
   OFFSET  SIZE   TYPE     DESCRIPTION
        0    12              (object header)
       12     4   int        Sample.a
       16     8   long       Sample.b
       24     1   boolean    Sample.c
       25     3              (alignment/padding gap)
       28     4   Object     Sample.d
       32     4              (object alignment gap)
   Instance size: 32 bytes
   Space losses: 3 bytes internal + 4 bytes external = 7 bytes total
*/
```

### 2.3 对象创建的完整过程

当 JVM 遇到 `new` 字节码指令时，依次执行以下步骤：

**第一步：类加载检查**

检查该类的符号引用是否已被解析，若未解析则先执行类加载流程。

**第二步：分配内存**

根据对象大小在堆中分配内存空间。两种分配方式：

| 方式 | 适用场景 | 原理 |
|------|---------|------|
| 指针碰撞（Bump the Pointer） | 内存规整（Serial、ParNew） | 移动堆顶指针 |
| 空闲列表（Free List） | 内存不规整（CMS） | 从链表中找足够大的空间 |

实际上 TLAB 是指针碰撞的优化，每个线程在自己的 TLAB 中无需同步。

**第三步：初始化零值**

将分配到的内存空间（不含对象头）全部初始化为零值。这保证了 Java 中字段不赋初值也能有默认值（`int` → 0，`Object` → null）。

**第四步：设置对象头**

JVM 对对象头进行必要设置：Mark Word（hash 为 0，年龄为 0）、类型指针、如果是数组则记录数组长度。

**第五步：执行 `<init>` 方法**

按照程序代码执行构造方法，进行对象初始化。至此，一个完整的 Java 对象创建完毕，引用该对象的栈帧局部变量表已指向堆中的对象地址。

---

## 三、垃圾回收算法

### 3.1 如何判断对象可回收

**引用计数法**

给每个对象添加一个引用计数器，有引用指向时 +1，引用断开时 -1，计数为 0 时回收。

优点：实现简单、判定高效。
缺点：**无法解决循环引用问题**。

```java
// 循环引用示例
public class ReferenceCountingDemo {
    public Object instance = null;

    public static void main(String[] args) {
        ReferenceCountingDemo objA = new ReferenceCountingDemo();
        ReferenceCountingDemo objB = new ReferenceCountingDemo();
        objA.instance = objB;  // objB 引用计数 +1
        objB.instance = objA;  // objA 引用计数 +1
        objA = null;
        objB = null;
        // objA 和 objB 的引用计数仍为 1，但实际已不可达
        System.gc(); // HotSpot 不使用引用计数，对象会被正确回收
    }
}
```

**可达性分析（Reachability Analysis）**

JVM 采用的方案。从一组称为 **GC Roots** 的根对象出发，沿引用链向下搜索。如果一个对象到 GC Roots 没有任何引用链，则判定为可回收。

```
GC Roots
   │
   ├──→ Object A ──→ Object B ──→ Object C  (存活)
   │
   ├──→ Object D ──→ Object E               (存活)
   │
   ╳    Object F ──→ Object G               (不可达，可回收)
          ↑           │
          └───────────┘  (循环引用，但仍会被回收)
```

**GC Roots 的种类：**

| GC Root 类型 | 说明 |
|-------------|------|
| 虚拟机栈中的引用 | 栈帧中局部变量表引用的对象 |
| 方法区中的静态变量引用 | `static` 字段引用的对象 |
| 方法区中的常量引用 | `final` 常量池引用的对象 |
| 本地方法栈 JNI 引用 | `Native` 方法中引用的对象 |
| 同步监视器持有的对象 | `synchronized` 持有的锁对象 |
| JVM 内部引用 | 基本类型的 Class 对象、系统类加载器、异常对象等 |

### 3.2 垃圾回收算法

**标记-清除（Mark-Sweep）**

```
回收前：
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ A  │    │ B  │    │ C  │    │ D  │    │
└────┴────┴────┴────┴────┴────┴────┴────┘

标记阶段：标记 A、B、D 为存活
清除阶段：清除未标记对象

回收后（产生碎片）：
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ A  │    │ B  │    │    │    │ D  │    │
└────┴────┴────┴────┴────┴────┴────┴────┘
```

- 优点：实现简单
- 缺点：产生内存碎片，大对象分配困难

**标记-复制（Mark-Copy，Cheney 算法）**

```
回收前：
S0 (From): ┌────┬────┬────┬────┐
           │ A  │ B  │ C  │ D  │
           └────┴────┴────┴────┘
S1 (To):   ┌────────────────────┐
           │      空闲          │
           └────────────────────┘

复制存活对象 A、B、D 到 S1：
S0 (From): ┌────────────────────┐
           │      全部清空      │
           └────────────────────┘
S1 (To):   ┌────┬────┬────┬────┐
           │ A  │ B  │ D  │    │
           └────┴────┴────┴────┘
```

- 优点：无碎片、分配效率高（指针碰撞）
- 缺点：浪费一半空间（新生代 Survivor 仅占 10% 缓解此问题）
- 适用：新生代（对象存活率低，复制成本小）

**标记-整理（Mark-Compact）**

```
回收前：
┌────┬────┬────┬────┬────┬────┬────┬────┐
│ A  │    │ B  │    │ C  │    │ D  │    │
└────┴────┴────┴────┴────┴────┴────┴────┘

标记存活对象 A、B、D，然后向一端移动：

回收后（无碎片）：
┌────┬────┬────┬────────────────────────┐
│ A  │ B  │ D  │        空闲            │
└────┴────┴────┴────────────────────────┘
```

- 优点：无碎片
- 缺点：移动对象需更新引用，STW 停顿较长
- 适用：老年代

**分代收集策略总结：**

| 区域 | 算法 | 理由 |
|------|------|------|
| 新生代 | 标记-复制 | 存活率低（约 10%），复制成本低 |
| 老年代 | 标记-清除 或 标记-整理 | 存活率高，复制不划算 |

### 3.3 垃圾回收器详解

**Serial / Serial Old**

```
Serial（新生代）：
  ┌─ Eden ──────────────┐
  │ [STW] 单线程复制     │
  └─────────────────────┘

Serial Old（老年代）：
  ┌─ Old Gen ───────────────────────┐
  │ [STW] 单线程 标记-整理           │
  └─────────────────────────────────┘
```

- 单线程执行，GC 时用户线程全部暂停
- 适合 Client 模式、小型应用
- 参数：`-XX:+UseSerialGC`

**ParNew**

- Serial 的多线程版本，新生代并行收集
- 必须与 Serial Old 或 CMS 配合使用
- 参数：`-XX:+UseParNewGC`（JDK 9 已废弃独立使用）

**Parallel Scavenge / Parallel Old**

- 与 ParNew 类似的多线程新生代收集器
- 核心区别：关注**吞吐量**（用户代码运行时间 / 总时间）而非停顿时间
- 自适应调节策略：`-XX:+UseAdaptiveSizePolicy`
- 参数：`-XX:+UseParallelGC`（JDK 8 默认）
- Parallel Old 是老年代配套，采用标记-整理

**CMS（Concurrent Mark Sweep）**

CMS 是一款以最短停顿时间为目标的老年代收集器，采用标记-清除算法。

```
CMS 回收流程（四个阶段）：

1. 初始标记 (Initial Mark)        [STW]
   ├── 标记 GC Roots 直接关联的对象
   └── 速度很快

2. 并发标记 (Concurrent Mark)     [并发]
   ├── 从 GC Roots 出发遍历整个对象图
   ├── 与用户线程同时运行
   └── 可能产生"浮动垃圾"

3. 重新标记 (Remark)              [STW]
   ├── 修正并发标记期间的变动
   ├── 使用增量更新（Incremental Update）
   └── 停顿时间比初始标记长，但远短于并发标记

4. 并发清除 (Concurrent Sweep)    [并发]
   ├── 清除不可达对象
   └── 与用户线程同时运行
```

CMS 的缺点：
- 对 CPU 资源敏感（默认启动 `(CPU核数 + 3) / 4` 个回收线程）
- 无法处理浮动垃圾（并发清除阶段新产生的垃圾需下次 GC 清理）
- 标记-清除产生碎片，大对象无法分配时退化为 Serial Old（Concurrent Mode Failure）

```bash
# CMS 典型配置
-XX:+UseConcMarkSweepGC
-XX:CMSInitiatingOccupancyFraction=75    # 老年代使用率达到 75% 时触发 CMS
-XX:+UseCMSInitiatingOccupancyOnly       # 只在达到阈值时触发，不自适应
-XX:+CMSParallelRemarkEnabled            # 并行重新标记
-XX:+CMSScavengeBeforeRemark             # 重新标记前先执行 Minor GC
```

> 注意：CMS 在 JDK 9 被标记为废弃，JDK 14 被移除。

**G1（Garbage First）**

G1 是 JDK 9+ 的默认 GC，它在逻辑上保留了分代概念，但物理上采用 **Region 化**内存布局：

```
G1 堆内存布局（Region 化）：

┌────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┬────┐
│ E  │ E  │ S  │ E  │ O  │ O  │ H  │ E  │ O  │ E  │ S  │    │
└────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┴────┘
 E = Eden Region    O = Old Region
 S = Survivor Region  H = Humongous Region (大对象)

默认 2048 个 Region，每个 Region 大小：1MB ~ 32MB（自动计算）
```

G1 的核心设计：

1. **Region 化**：堆被划分为大小相等的 Region，每个 Region 可以动态充当 Eden、Survivor、Old 或 Humongous。
2. **Humongous Region**：对象大小超过 Region 大小 50% 时分配在连续的 Humongous Region 中。
3. **Remembered Set（RSet）**：每个 Region 维护一个 RSet，记录其他 Region 对本 Region 内对象的引用，避免全堆扫描。
4. **Collection Set（CSet）**：每次 GC 要回收的 Region 集合。

G1 的回收过程：

```
Young GC（混合回收的第一步）：
  [STW] 并行复制存活对象到 Survivor/Old Region

并发标记周期：
  1. 初始标记 (STW, 搭载在 Young GC 上)
  2. 并发根节点扫描
  3. 并发标记
  4. 最终标记 (STW, SATB 快照处理)
  5. 清理 (STW, 更新 RSet, 回收全空 Region)

Mixed GC（老年代回收）：
  [STW] 同时回收 Young + 部分 Old Region
  根据 -XX:G1MixedGCCountTarget (默认 8) 分多次完成
  当可回收垃圾低于 -XX:G1HeapWastePercent (默认 5%) 时停止
```

```bash
# G1 典型配置
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200              # 目标最大停顿时间
-XX:G1HeapRegionSize=4m               # 手动指定 Region 大小
-XX:InitiatingHeapOccupancyPercent=45  # 并发标记触发阈值
-XX:G1NewSizePercent=20               # 新生代最小占比
-XX:G1MaxNewSizePercent=60            # 新生代最大占比
-XX:G1MixedGCCountTarget=8            # Mixed GC 次数
-XX:G1HeapWastePercent=5              # 可回收垃圾低于此比例停止 Mixed GC
-XX:ConcGCThreads=4                   # 并发标记线程数
```

**ZGC（Z Garbage Collector）**

ZGC 是 JDK 11 引入的实验性低延迟收集器（JDK 15 正式发布），目标是停顿时间不超过 10ms，且停顿时间不随堆大小增长。

核心技术：
- **染色指针（Colored Pointers）**：在 64 位指针中嵌入 4 位标记信息（Marked0、Marked1、Remapped、Finalizable），避免额外的 Mark Bitmap。
- **读屏障（Load Barrier）**：在对象引用被加载时检查染色指针状态，实现并发转移。
- **并发转移**：对象移动与用户线程并发执行，极大缩短 STW 时间。

```bash
# ZGC 配置
-XX:+UseZGC                          # 启用 ZGC
-XX:+ZGenerational                   # JDK 21+ 分代 ZGC
-Xmx16g                              # 推荐至少 8GB 堆
-XX:SoftMaxHeapSize=12g              # 软上限
-XX:ConcGCThreads=4                  # 并发线程数
-Xlog:gc*:file=gc.log               # GC 日志
```

**Shenandoah**

由 Red Hat 开发，与 ZGC 目标类似但实现不同：
- 使用 **Brooks 指针**（对象头中的转发指针）实现并发转移
- 使用 **并发整理** 而非复制算法
- JDK 12 引入，JDK 15 正式发布

```bash
-XX:+UseShenandoahGC
-XX:ShenandoahGCHeuristics=adaptive   # 自适应启发式
```

**GC 选择参考：**

| 场景 | 推荐 GC | 原因 |
|------|---------|------|
| 小型应用（<100MB 堆） | Serial | 简单、无多线程开销 |
| 吞吐量优先（批处理） | Parallel | 最大化 CPU 利用率 |
| 响应时间敏感（Web 服务） | G1 | 均衡吞吐与延迟 |
| 超低延迟（交易系统） | ZGC / Shenandoah | 亚毫秒级停顿 |
| 大堆（>32GB） | ZGC | 停顿不随堆增长 |

### 3.4 安全点与安全区域

**安全点（Safe Point）**

JVM 并非可以在任意位置发起 GC 停顿。安全点是程序执行流中的特定位置，在这些位置上，虚拟机对整个堆的引用关系有完整、一致的快照。

安全点通常设置在：
- 方法调用前
- 循环跳转处（如 `while`、`for` 的回边指令）
- 异常跳转处
- GC 安全指令

当 GC 发起时，JVM 有两种方式让线程到达安全点：
- **抢先式中断（Preemptive）**：中断所有线程，不在安全点的线程继续执行到安全点（已基本废弃）
- **主动式中断（Voluntary）**：设置中断标志，线程轮询标志位后主动挂起

**记忆集（Remembered Set）与卡表（Card Table）**

在分代收集中，新生代 GC 时需要扫描老年代对新生代的引用。如果全堆扫描老年代，效率极低。

- **记忆集**：一种抽象数据结构，记录从非收集区域指向收集区域的引用集合。
- **卡表**：记忆集的一种具体实现。将老年代内存划分为固定大小的"卡页"（通常 512 字节），用一个字节数组记录每张卡页的状态（"脏" 或 "干净"）。

```
卡表示意：

老年代内存：
┌────────┬────────┬────────┬────────┬────────┐
│ Card 0 │ Card 1 │ Card 2 │ Card 3 │ Card 4 │  (每个 512 bytes)
│ 0x1000 │ 0x1200 │ 0x1400 │ 0x1600 │ 0x1800 │
└────────┴────────┴────────┴────────┴────────┘

卡表数组：
┌───┬───┬───┬───┬───┐
│ 0 │ 1 │ 0 │ 1 │ 0 │   1 = 脏（含跨代引用）
└───┴───┴───┴───┴───┘   0 = 干净

Minor GC 时只需扫描标记为"脏"的卡页
```

写入屏障（Write Barrier）用于在引用变更时将对应卡页标记为脏。G1 的 RSet 是卡表的精细化版本，精确到 Region 级别。

---

## 四、JVM 调优实战

### 4.1 关键 JVM 参数

```bash
# ========================
# 堆内存配置
# ========================
-Xms4g                              # 初始堆大小（建议与 Xmx 相同，避免动态扩缩）
-Xmx4g                              # 最大堆大小
-Xmn2g                              # 新生代大小（通常为堆的 1/3 ~ 1/2）
-XX:SurvivorRatio=8                 # Eden:Survivor = 8:1（即 S0=S1 各占新生代 1/10）
-XX:NewRatio=2                      # 老年代:新生代 = 2:1（默认值）
-XX:MaxTenuringThreshold=15         # 对象晋升老年代年龄阈值
-XX:PretenureSizeThreshold=10m      # 大对象直接进入老年代阈值（仅 Serial/ParNew）
-XX:+UseTLAB                        # 启用 TLAB（默认开启）

# ========================
# GC 选择配置
# ========================
# G1（推荐，JDK 9+ 默认）
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200
-XX:G1HeapRegionSize=4m
-XX:InitiatingHeapOccupancyPercent=45

# Parallel（JDK 8 默认，吞吐量优先）
-XX:+UseParallelGC
-XX:+UseParallelOldGC

# CMS（JDK 8 Web 服务常用，JDK 14 移除）
-XX:+UseConcMarkSweepGC
-XX:CMSInitiatingOccupancyFraction=75
-XX:+UseCMSInitiatingOccupancyOnly

# ========================
# 元空间配置
# ========================
-XX:MetaspaceSize=256m              # 初始元空间大小
-XX:MaxMetaspaceSize=512m           # 最大元空间

# ========================
# 栈配置
# ========================
-Xss512k                            # 线程栈大小（默认 1MB）

# ========================
# GC 日志
# ========================
# JDK 8 格式
-XX:+PrintGCDetails
-XX:+PrintGCDateStamps
-XX:+PrintGCTimeStamps
-XX:+PrintHeapAtGC
-Xloggc:/var/log/app/gc.log
-XX:+UseGCLogFileRotation
-XX:NumberOfGCLogFiles=10
-XX:GCLogFileSize=50M

# JDK 9+ 统一日志框架
-Xlog:gc*,gc+age=trace,safepoint:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=10,filesize=50M

# ========================
# OOM 诊断
# ========================
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/var/log/app/heapdump.hprof
-XX:+ExitOnOutOfMemoryError         # OOM 时直接退出（配合容器重启）
-XX:ErrorFile=/var/log/app/hs_err_%p.log  # 崩溃日志

# ========================
# JIT 编译
# ========================
-XX:CompileThreshold=10000          # 方法调用次数达到此值时 JIT 编译
-XX:+PrintCompilation               # 打印 JIT 编译日志
```

### 4.2 GC 日志分析

**开启 GC 日志后的典型输出（JDK 8 Parallel GC）：**

```
2024-01-15T10:23:45.678+0800: 12.345: [GC (Allocation Failure)
  [PSYoungGen: 524288K->32768K(611648K)]
  1048576K->573440K(1980928K),
  0.0234567 secs]
  [Times: user=0.08 sys=0.01, real=0.02 secs]
```

逐字段解析：

| 字段 | 含义 |
|------|------|
| `2024-01-15T10:23:45.678+0800` | GC 发生的绝对时间 |
| `12.345` | JVM 启动后的相对时间（秒） |
| `GC` | Minor GC（`Full GC` 表示完全 GC） |
| `Allocation Failure` | GC 触发原因（内存分配失败） |
| `PSYoungGen: 524288K->32768K(611648K)` | 新生代：GC前→GC后（总容量） |
| `1048576K->573440K(1980928K)` | 整个堆：GC前→GC后（总容量） |
| `0.0234567 secs` | GC 停顿时间 |
| `user=0.08` | GC 线程消耗的 CPU 时间（多核并行，可能 > real） |
| `real=0.02` | 实际停顿时间（挂钟时间） |

**关键调优指标：**

```
吞吐量 = 用户代码运行时间 / (用户代码运行时间 + GC 时间)
目标：> 99%

停顿时间 = 单次 GC 停顿时长
目标：Minor GC < 100ms，Major GC < 500ms（视业务要求）

GC 频率 = 单位时间内 GC 次数
目标：Minor GC 间隔 > 10s，Full GC 间隔 > 1h
```

**使用 GCEasy（在线工具）或 GCViewer 分析 GC 日志，关注：**
- Throughput（吞吐量百分比）
- Pause 分布（P50/P99/Max）
- Heap 使用趋势（是否有内存泄漏）
- Promotion 速率（新生代晋升老年代的速度，正常应 < 10MB/s）

### 4.3 常用诊断工具

**JDK 自带命令行工具：**

```bash
# jps —— 查看 Java 进程
jps -lvm
# 输出示例：
# 12345 com.example.Application -Xms4g -Xmx4g
# 12346 sun.tools.jps.Jps -lvm

# jstat —— 实时监控 GC 状态
jstat -gcutil 12345 1000 10    # 每 1 秒输出一次，共 10 次
# 输出字段：
# S0   S1   E    O    M    CCS  YGC  YGCT  FGC  FGCT  GCT
# 0.00 45.2 67.8 23.4 95.6 92.1  156  2.34   3  1.23  3.57

# jmap —— 堆内存快照
jmap -heap 12345               # 查看堆配置和使用情况
jmap -histo:live 12345         # 查看存活对象直方图（会触发 Full GC）
jmap -dump:format=b,file=heap.hprof 12345  # 导出堆转储

# jstack —— 线程栈快照
jstack 12345                   # 查看线程栈（排查死锁、阻塞）
jstack -l 12345                # 附加锁信息

# jcmd —— 综合诊断（JDK 7+，推荐替代 jmap/jstack）
jcmd 12345 GC.heap_dump /tmp/heap.hprof
jcmd 12345 Thread.print -l
jcmd 12345 VM.flags             # 查看生效的 JVM 参数
jcmd 12345 GC.class_histogram
```

**VisualVM**

JDK 自带的可视化工具（JDK 11+ 需单独下载），功能包括：
- CPU / 内存 / GC 实时监控
- 线程监控（线程状态、死锁检测）
- 堆转储 & OQL 查询
- MBean 管理
- 插件扩展（如 Visual GC 插件，可视化观察 Eden/Survivor/Old 变化）

**Arthas（阿里巴巴开源）**

线上诊断神器，无需重启应用：

```bash
# 下载并启动
curl -O https://arthas.aliyun.com/arthas-boot.jar
java -jar arthas-boot.jar

# 常用命令
dashboard                    # 实时系统面板（线程、内存、GC、Runtime）
thread -n 3                  # CPU 使用率最高的 3 个线程
thread -b                    # 查找阻塞线程（死锁检测）
watch com.example.Service getUser '{params, returnObj, throwExp}' -x 3
                             # 观察方法入参、返回值、异常
trace com.example.Service getUser '#cost > 100'
                             # 追踪方法耗时（> 100ms 的调用）
jad com.example.Service getUser
                             # 反编译方法（确认线上代码版本）
sc -d com.example.model.User
                             # 查看类的 ClassLoader 信息
heapdump /tmp/dump.hprof     # 导出堆转储
profiler start               # 启动 CPU 火焰图采样
profiler stop --format html  # 生成火焰图
```

**MAT（Memory Analyzer Tool）**

Eclipse 出品的堆转储分析工具，用于分析 `.hprof` 文件：

1. 打开 heap dump 文件
2. 查看 **Leak Suspects Report**（自动分析疑似泄漏点）
3. **Dominator Tree**：按 retained size 排序，找出占用内存最大的对象
4. **Histogram**：按类统计对象数量和大小
5. **OQL（Object Query Language）**：`SELECT * FROM java.lang.String s WHERE s.count > 1000`
6. **Path to GC Roots**：分析对象为何未被回收（找出意外持有的引用链）

### 4.4 常见 OOM 场景与解决

**场景一：堆溢出（Java heap space）**

```
java.lang.OutOfMemoryError: Java heap space
```

原因：堆内存不足以分配新对象。可能是内存泄漏，也可能是堆设置过小。

排查步骤：
1. 添加 `-XX:+HeapDumpOnOutOfMemoryError` 参数
2. 用 MAT 分析 heap dump，查看 Dominator Tree
3. 找到占用内存最大的对象及其 GC Roots Path
4. 判断是泄漏（不该持有的对象）还是合理的大对象

```java
// 内存泄漏示例：未关闭的资源
public class MemoryLeakDemo {
    // 静态集合持有引用，永远不会被回收
    private static final List<byte[]> cache = new ArrayList<>();

    public void leak() {
        while (true) {
            cache.add(new byte[1024 * 1024]); // 每次添加 1MB
        }
    }
}
// 解决：使用 WeakHashMap、SoftReference，或设置 TTL 清理策略
```

**场景二：栈溢出（StackOverflowError）**

```
java.lang.StackOverflowError
```

原因：线程栈深度超过限制。最常见于无限递归。

排查步骤：
1. 执行 `jstack <pid>` 获取线程栈
2. 查看报错线程的调用栈，找到重复出现的方法调用
3. 如果是合理深度，可通过 `-Xss` 增大栈大小

```bash
# 增大线程栈到 2MB
-Xss2m
```

**场景三：元空间溢出（Metaspace）**

```
java.lang.OutOfMemoryError: Metaspace
```

原因：加载的类过多。常见于使用大量动态代理（CGLIB、Javassist）、Groovy/Scala 脚本引擎、热部署频繁等场景。

排查步骤：
1. 使用 `-XX:+TraceClassLoading` 和 `-XX:+TraceClassUnloading` 追踪类加载/卸载
2. 用 Arthas `sc` 命令查看类数量
3. 检查是否存在类加载器泄漏（旧 ClassLoader 未被回收，其加载的类也无法卸载）

```bash
# 增大元空间
-XX:MetaspaceSize=512m
-XX:MaxMetaspaceSize=1g
```

**场景四：直接内存溢出（Direct buffer memory）**

```
java.lang.OutOfMemoryError: Direct buffer memory
```

原因：NIO 的 `DirectByteBuffer` 分配的直接内存超限。Netty、Kafka 等框架大量使用直接内存。

排查步骤：
1. 检查 `-XX:MaxDirectMemorySize` 配置（默认等于 `-Xmx`）
2. 监控直接内存使用量：`ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class)`
3. 检查是否存在 DirectByteBuffer 泄漏（未显式释放或未依赖 GC 回收 Cleaner）

```bash
# 设置直接内存上限
-XX:MaxDirectMemorySize=2g

# Netty 中限制池化内存
-Dio.netty.maxDirectMemory=1073741824
-Dio.netty.allocator.type=unpooled   # 禁用池化（排查时）
```

**场景五：GC Overhead Limit Exceeded**

```
java.lang.OutOfMemoryError: GC overhead limit exceeded
```

原因：超过 98% 的时间用于 GC 且回收的内存不到 2%。本质是堆内存严重不足，GC 在做无用功。

解决：
1. 增大堆内存 `-Xmx`
2. 排查内存泄漏
3. 如确实需要，可通过 `-XX:-UseGCOverheadLimit` 禁用此限制（治标不治本）

**场景六：无法创建新线程**

```
java.lang.OutOfMemoryError: unable to create new native thread
```

原因：线程数超过操作系统限制。每个线程默认占用 1MB 栈内存。

排查：
```bash
# 查看线程数
cat /proc/<pid>/status | grep Threads
# 或使用 Arthas
thread --all | wc -l

# 解决：减小栈大小或限制线程数
-Xss256k                          # 减小线程栈
-XX:ParallelGCThreads=4           # 限制 GC 线程数
```

---

## 五、类加载机制深入

### 5.1 类的主动使用与被动使用

JVM 规范规定了 **六种主动使用** 场景，必须触发类的初始化：

| 序号 | 场景 | 示例 |
|------|------|------|
| 1 | `new` 对象、读写静态字段、调用静态方法 | `new MyClass()` |
| 2 | 反射调用 | `Class.forName("com.example.MyClass")` |
| 3 | 初始化子类时先初始化父类 | `Child.staticField` → 先初始化 `Parent` |
| 4 | 启动时主类 | `java Main` → 初始化 `Main` |
| 5 | `MethodHandle` 解析的类 | JSR 292 动态调用 |
| 6 | 接口默认方法的实现类初始化 | JDK 8 接口的 `default` 方法 |

**被动使用** 不触发初始化：
- 通过子类引用父类的静态字段（只初始化父类）
- 通过数组定义引用类：`MyClass[] arr = new MyClass[10]`（不触发初始化）
- 引用编译期常量：`MyClass.CONSTANT`（常量在编译期已嵌入调用方常量池）

### 5.2 类加载的完整流程

```
.class 文件
     │
     ▼
┌─────────────────────────────────────┐
│ 1. Loading（加载）                   │
│    - 查找 .class 字节流              │
│    - 解析为方法区的运行时数据结构     │
│    - 生成 java.lang.Class 对象       │
├─────────────────────────────────────┤
│ 2. Linking（链接）                   │
│    2.1 Verification（验证）          │
│        - 文件格式、元数据、字节码验证 │
│    2.2 Preparation（准备）           │
│        - 静态变量分配内存，赋零值     │
│    2.3 Resolution（解析）            │
│        - 符号引用 → 直接引用          │
├─────────────────────────────────────┤
│ 3. Initialization（初始化）          │
│    - 执行 <clinit> 方法              │
│    - 静态变量赋值 + 静态代码块        │
├─────────────────────────────────────┤
│ 4. Using（使用）                     │
│    - 对象创建、方法调用               │
├─────────────────────────────────────┤
│ 5. Unloading（卸载）                 │
│    - 无实例、ClassLoader 已回收、     │
│      Class 对象无引用                │
└─────────────────────────────────────┘
```

### 5.3 自定义类加载器

自定义类加载器通常继承 `java.lang.ClassLoader` 并重写 `findClass` 方法。如需打破双亲委派，则重写 `loadClass` 方法。

```java
/**
 * 自定义文件类加载器：从指定目录加载 .class 文件
 */
public class CustomClassLoader extends ClassLoader {

    private final String classPath;

    public CustomClassLoader(String classPath) {
        this.classPath = classPath;
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        byte[] classData = loadClassData(name);
        if (classData == null) {
            throw new ClassNotFoundException("Cannot find class: " + name);
        }
        // defineClass 将字节数组转换为 Class 对象
        return defineClass(name, classData, 0, classData.length);
    }

    private byte[] loadClassData(String className) {
        String fileName = className.replace('.', File.separatorChar) + ".class";
        String fullPath = classPath + File.separator + fileName;
        try (InputStream is = new FileInputStream(fullPath);
             ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            int ch;
            while ((ch = is.read()) != -1) {
                baos.write(ch);
            }
            return baos.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    public static void main(String[] args) throws Exception {
        CustomClassLoader loader = new CustomClassLoader("/tmp/classes");
        Class<?> clazz = loader.loadClass("com.example.HelloWorld");
        Object instance = clazz.getDeclaredConstructor().newInstance();
        System.out.println(instance.getClass().getClassLoader());
        // 输出: CustomClassLoader@...
    }
}
```

**打破双亲委派实现热加载：**

```java
/**
 * 热加载类加载器：每次加载都创建新实例，不委派父加载器
 */
public class HotSwapClassLoader extends ClassLoader {

    private final String classPath;

    public HotSwapClassLoader(String classPath) {
        // 父加载器设为 null，完全自行加载
        super(null);
        this.classPath = classPath;
    }

    @Override
    protected Class<?> loadClass(String name, boolean resolve)
            throws ClassNotFoundException {
        synchronized (getClassLoadingLock(name)) {
            // java.* 和 javax.* 仍然委派给 Bootstrap
            if (name.startsWith("java.") || name.startsWith("javax.")) {
                return getSystemClassLoader().getParent().loadClass(name);
            }

            Class<?> c = findLoadedClass(name);
            if (c == null) {
                c = findClass(name);  // 自行加载，不使用缓存
            }
            if (resolve) {
                resolveClass(c);
            }
            return c;
        }
    }

    @Override
    protected Class<?> findClass(String name) throws ClassNotFoundException {
        // 每次从磁盘读取最新的 .class 文件
        byte[] data = loadClassData(name);
        if (data == null) {
            throw new ClassNotFoundException(name);
        }
        return defineClass(name, data, 0, data.length);
    }

    // ... loadClassData 实现同上
}

// 使用方式：每次热部署创建新的 ClassLoader 实例
HotSwapClassLoader loader1 = new HotSwapClassLoader("/app/classes");
Class<?> v1 = loader1.loadClass("com.example.Service");

// 文件更新后
HotSwapClassLoader loader2 = new HotSwapClassLoader("/app/classes");
Class<?> v2 = loader2.loadClass("com.example.Service");
// v1 != v2，因为由不同的 ClassLoader 加载
```

### 5.4 热部署原理

热部署的核心原理基于 JVM 的一条基本规则：

> **两个类是否"相等"，不仅要求类名相同，还要求由同一个类加载器加载。**

即 `Class.equals()` 同时比较类名和 ClassLoader 实例。

```
热部署流程：

1. 监听 .class 文件变化（文件系统 Watcher）
          │
          ▼
2. 创建新的 ClassLoader 实例
          │
          ▼
3. 使用新 ClassLoader 加载新版 .class
          │
          ▼
4. 销毁旧 ClassLoader（确保无引用持有旧类）
          │
          ▼
5. 更新应用引用（Spring 容器重建 Bean 等）

关键约束：
- 旧 ClassLoader 必须能被 GC 回收
- 不能持有旧类的静态引用
- ThreadLocal 中的旧类引用需要清理
```

Tomcat 的热部署实现：
- 每个 Web 应用使用独立的 `WebAppClassLoader`
- 热部署时销毁旧 `WebAppClassLoader`，创建新实例
- `WebAppClassLoader` 打破双亲委派：优先加载 `WEB-INF/classes` 和 `WEB-INF/lib` 中的类

Spring DevTools 的热重启实现：
- 使用 `RestartClassLoader` 加载应用代码（可热替换）
- 使用 `AppClassLoader` 加载第三方依赖（不变）
- 通过类加载器隔离实现快速重启

---

## 六、JVM 面试题精选

**Q1：JVM 运行时数据区有哪些？各自的作用是什么？**

A：JVM 运行时数据区分为五大区域：
- **程序计数器**：记录当前线程执行的字节码指令地址，唯一不会 OOM 的区域。
- **虚拟机栈**：线程私有，每个方法调用创建一个栈帧，存储局部变量表、操作数栈、动态链接、返回地址。栈深度超过限制抛出 `StackOverflowError`。
- **本地方法栈**：为 `native` 方法服务，HotSpot 中与虚拟机栈合一。
- **堆**：线程共享，存储几乎所有对象实例，GC 的核心区域。
- **方法区（元空间）**：存储类信息、常量池、静态变量、JIT 编译代码。JDK 8+ 使用本地内存实现。

**Q2：什么是双亲委派模型？为什么要打破它？如何打破？**

A：双亲委派模型规定类加载请求优先委派给父加载器处理，只有父加载器无法加载时才由子加载器自行加载。其目的是保证 Java 核心类库的安全性（防止用户自定义 `java.lang.String`）和避免重复加载。

打破场景包括：SPI 机制（线程上下文类加载器）、Tomcat（Web 应用隔离）、OSGi（模块热部署）、热修复。打破方式是重写 `loadClass` 方法，在满足自定义条件时直接调用 `findClass` 而不委派父加载器。

**Q3：Minor GC 和 Full GC 分别在什么情况下触发？**

A：
- **Minor GC**：Eden 区空间不足时触发。
- **Full GC** 触发条件包括：
  1. 老年代空间不足
  2. 元空间不足
  3. `System.gc()` 调用（建议，非强制）
  4. Minor GC 后老年代剩余空间不足以容纳晋升对象（空间分配担保失败）
  5. CMS 的 Concurrent Mode Failure（并发回收未完成时老年代已满）
  6. 使用 `jmap -histo:live` 等触发

**Q4：对象在内存中的布局是怎样的？对象头包含哪些信息？**

A：对象由三部分组成：
1. **对象头**：Mark Word（8 字节，存储 hashCode、GC 分代年龄、锁状态标志、偏向线程 ID 等）+ 类型指针（4/8 字节，指向元空间的 Class 元数据）+ 数组长度（仅数组对象，4 字节）。
2. **实例数据**：对象真正存储的有效信息，包括父类和本类的字段值。
3. **对齐填充**：将对象大小补齐到 8 字节的整数倍。

**Q5：CMS 和 G1 的区别是什么？各自适合什么场景？**

A：

| 维度 | CMS | G1 |
|------|-----|-----|
| 内存布局 | 传统分代（连续空间） | Region 化（2048 个等大 Region） |
| 回收算法 | 标记-清除 | 标记-整理 + 复制 |
| 碎片问题 | 有，可能导致 Full GC | 无 |
| 停顿预测 | 不支持 | 支持（`-XX:MaxGCPauseMillis`） |
| JDK 支持 | JDK 14 移除 | JDK 9+ 默认 |
| 适用场景 | JDK 8 Web 服务 | JDK 9+ 通用场景 |

**Q6：什么是 TLAB？为什么它能提高对象分配效率？**

A：TLAB（Thread Local Allocation Buffer）是 JVM 为每个线程在 Eden 区分配的一小块私有缓冲区（默认 1024KB）。对象分配时优先在 TLAB 中进行，由于是线程私有的，无需加锁，只需要移动指针即可完成分配，极大提高了分配效率。当 TLAB 用尽时，线程需要与其他线程通过 CAS 操作竞争 Eden 区空间。

**Q7：强引用、软引用、弱引用、虚引用有什么区别？各自的应用场景是什么？**

A：

| 引用类型 | 回收时机 | 典型用途 |
|---------|---------|---------|
| 强引用（StrongReference） | 永不回收（只要可达） | 绝大多数对象引用 |
| 软引用（SoftReference） | 内存不足时回收 | 内存敏感的缓存 |
| 弱引用（WeakReference） | 下次 GC 时回收 | `WeakHashMap`、`ThreadLocal` 清理 |
| 虚引用（PhantomReference） | 随时回收，无法获取对象 | 跟踪对象被回收的活动 |

```java
// 软引用缓存示例
SoftReference<byte[]> cache = new SoftReference<>(new byte[1024 * 1024]);
byte[] data = cache.get(); // 可能返回 null（已被回收）

// 弱引用示例：避免 ThreadLocal 内存泄漏
// ThreadLocal 内部使用 WeakReference<ThreadLocal> 作为 key
```

**Q8：JVM 如何判断一个对象是否可以被回收？**

A：JVM 使用可达性分析算法。从 GC Roots 出发，沿引用链向下搜索，无法到达的对象即为可回收。GC Roots 包括：虚拟机栈中引用的对象、方法区静态变量引用的对象、方法区常量引用的对象、本地方法栈 JNI 引用的对象。

不可达对象不会立即回收，还需经过 `finalize()` 方法的最终判定（如果对象覆写了 `finalize` 且未被调用过，会被放入 F-Queue 等待执行）。但 `finalize` 方法不推荐使用，因为执行时机不确定、性能差，应使用 `Cleaner` 或 `try-with-resources` 替代。

**Q9：什么是安全点（Safe Point）？为什么 GC 需要在安全点进行？**

A：安全点是程序执行流中的特定位置，在这些位置上 JVM 能够获取到完整且一致的引用关系快照。GC 需要暂停所有用户线程（STW），但线程不能在任意位置暂停——如果在线程正在修改引用关系时暂停，会导致引用图不一致，产生错误标记。因此 JVM 在安全点设置轮询指令（poll），线程执行到安全点时检查是否需要暂停，从而实现安全的 STW。

**Q10：线上系统出现频繁 Full GC，你会怎么排查？**

A：排查步骤：
1. **获取信息**：`jstat -gcutil <pid> 1000` 观察 GC 频率和耗时，确认 Full GC 间隔和持续时间。
2. **查看日志**：分析 GC 日志，确认 Full GC 触发原因（Allocation Failure、Metadata GC Threshold、System.gc() 等）。
3. **堆转储**：`jmap -dump:live,format=b,file=heap.hprof <pid>`（注意会触发 Full GC 并暂停应用）。
4. **MAT 分析**：打开 heap dump，查看 Leak Suspects、Dominator Tree、Histogram，定位大对象或泄漏点。
5. **GC Roots Path**：对可疑对象执行 Path to GC Roots，找出谁在持有引用导致无法回收。
6. **代码修复**：根据分析结果修复内存泄漏或调整 JVM 参数。
7. **验证效果**：修复后持续监控 GC 指标，确认 Full GC 频率降低到可接受范围。

常见原因包括：内存泄漏（集合持续增长未清理）、大对象频繁分配、老年代碎片化（CMS 场景）、元空间不足、`System.gc()` 误调用等。

---

## 总结

JVM 是 Java 生态最核心的基础设施，理解其内部机制对于构建高性能、高可用的 Java 应用至关重要。本文从以下几个维度进行了全面剖析：

1. **架构层面**：类加载子系统的五个阶段、双亲委派模型的原理与打破场景、运行时数据区的五大区域及其 OOM 场景。

2. **内存管理**：堆的分代布局、TLAB 分配策略、对象的内存布局（Mark Word + 类型指针 + 实例数据 + 对齐填充）、对象创建的完整流程。

3. **垃圾回收**：可达性分析与 GC Roots、四种经典回收算法、六种主流垃圾回收器（Serial、ParNew、Parallel、CMS、G1、ZGC/Shenandoah）的设计原理与适用场景。

4. **性能调优**：关键 JVM 参数的含义与配置、GC 日志的逐字段分析、jps/jstat/jmap/jstack/Arthas/MAT 等诊断工具的实战用法、六种常见 OOM 场景的排查与解决。

5. **类加载机制**：主动使用与被动使用的区分、自定义类加载器的实现、热部署的底层原理。

JVM 调优没有银弹，核心方法论是：**监控 → 分析 → 假设 → 验证 → 迭代**。在生产环境中，应始终保持 `-XX:+HeapDumpOnOutOfMemoryError` 开启、GC 日志持久化存储，并建立完善的监控告警体系，才能在问题发生时快速定位、精准修复。

随着 JDK 版本的演进，ZGC 和分代 ZGC（JDK 21）正在将 GC 停顿推向亚毫秒级别，JVM 的内存管理正在变得越来越智能。但底层的内存模型、类加载机制、GC 原理——这些不变的根基——仍然是每个 Java 工程师进阶的必修课。
