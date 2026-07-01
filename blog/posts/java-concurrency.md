# Java 并发编程核心原理——从线程到 JUC 全面解析

## 引言

在现代软件开发中，并发编程已经从"可选项"变成了"必修课"。随着多核 CPU 的普及和分布式系统的兴起，如何高效、安全地利用计算资源，成为每一个 Java 开发者必须面对的核心课题。

并发编程的本质挑战可以归结为三个核心问题：

- **原子性（Atomicity）**：一个或多个操作要么全部执行且不被中断，要么都不执行。例如 `i++` 看似一行代码，实际包含"读—改—写"三个步骤，在多线程下极易出现数据竞争。
- **可见性（Visibility）**：当一个线程修改了共享变量的值，其他线程能否立即看到这个修改。由于 CPU 缓存和编译器优化的存在，线程往往在自己的工作内存中操作变量副本，导致"脏读"。
- **有序性（Ordering）**：程序执行的顺序是否与代码顺序一致。编译器和 CPU 为了性能会进行指令重排序（Instruction Reordering），单线程下无影响，多线程下却可能引发难以排查的 Bug。

本文将从 Java 内存模型（JMM）出发，逐层深入线程基础、JUC 工具包、并发容器、线程池、原子操作类以及 CompletableFuture 异步编程，配合源码分析和实战示例，帮助读者建立系统而扎实的并发编程知识体系。

---

## 一、Java 内存模型（JMM）

### 1.1 主内存与工作内存

Java 内存模型（Java Memory Model，JMM）并非描述 JVM 的物理内存布局，而是一套规范，定义了多线程环境下共享变量的读写行为。

JMM 将内存抽象为两部分：

- **主内存（Main Memory）**：存储所有共享变量，逻辑上对应堆内存，所有线程均可访问。
- **工作内存（Working Memory）**：每个线程拥有自己的工作内存，存储该线程使用的共享变量副本。线程对变量的所有操作都在工作内存中进行，不能直接操作主内存。

两个线程之间的通信必须通过主内存完成：线程 A 将修改后的值写回主内存，线程 B 再从主内存读取最新值。

JMM 通过 **happens-before** 规则来保证内存可见性，核心规则包括：

1. **程序顺序规则**：同一线程中，前面的操作 happens-before 后面的操作。
2. **监视器锁规则**：对同一锁的 unlock 操作 happens-before 后续的 lock 操作。
3. **volatile 规则**：对 volatile 变量的写 happens-before 后续的读。
4. **传递性**：若 A happens-before B，B happens-before C，则 A happens-before C。
5. **线程启动规则**：`Thread.start()` 的调用 happens-before 被启动线程中的任何操作。
6. **线程终止规则**：线程中的所有操作 happens-before 其他线程检测到该线程终止（`join` 返回或 `isAlive()` 为 false）。

### 1.2 volatile 关键字

`volatile` 是 Java 提供的轻量级同步机制，具有两大语义：

**可见性保证**

当一个变量被 `volatile` 修饰后，线程每次读取都直接从主内存读取，每次写入都立即刷新到主内存。从底层实现来看，JVM 会在 volatile 读写前后插入内存屏障（Memory Barrier）：

```java
// volatile 读操作插入 LoadLoad + LoadStore 屏障
// volatile 写操作插入 StoreStore + StoreLoad 屏障

// 示例：volatile 变量
private volatile boolean running = true;

public void stop() {
    running = false; // 写操作立即对其他线程可见
}

public void doWork() {
    while (running) {
        // 每次循环都从主内存读取 running
    }
}
```

**禁止指令重排序**

volatile 通过内存屏障阻止编译器和 CPU 对指令进行重排序，这在双重检查锁定（DCL）单例模式中尤为关键。

**volatile 不保证原子性的原因**

以 `volatile int count; count++;` 为例，该操作包含三步：读 count、count+1、写 count。即使 count 是 volatile 的，两个线程可能同时读到相同的旧值，各自加 1 后写回，导致实际只加了 1 而非 2。

**DCL 单例为什么要 volatile**

```java
public class Singleton {
    // 必须用 volatile 修饰！
    private static volatile Singleton instance;

    private Singleton() {}

    public static Singleton getInstance() {
        if (instance == null) {                // 第一次检查（无锁）
            synchronized (Singleton.class) {
                if (instance == null) {        // 第二次检查（有锁）
                    instance = new Singleton();
                }
            }
        }
        return instance;
    }
}
```

`new Singleton()` 在字节码层面分为三步：(1) 分配内存空间；(2) 初始化对象；(3) 将引用指向内存地址。若不使用 volatile，步骤 2 和步骤 3 可能被重排序为 1→3→2，此时另一个线程在第一次检查时发现 `instance != null`，直接返回了一个尚未初始化完成的对象，引发 NPE。volatile 通过禁止重排序彻底杜绝了这一隐患。

### 1.3 synchronized 原理

**对象头与 Monitor**

Java 中每个对象都有一个对象头（Object Header），其中包含 Mark Word（存储锁信息）和类型指针。在 HotSpot JVM 中，Mark Word 的结构如下：

```
|-------------------------------------------------|
|  Mark Word (64-bit)                             |
|-------------------------------------------------|
|  无锁:    hashCode | 分代年龄 | 0  | 01          |
|  偏向锁:  threadId | epoch   | 分代年龄 | 1 | 01 |
|  轻量级锁: 指向栈中锁记录的指针        | 00        |
|  重量级锁: 指向 Monitor 的指针         | 10        |
|-------------------------------------------------|
```

Monitor（监视器）是 synchronized 底层依赖的操作系统 Mutex Lock，包含 EntryList（等待队列）和 WaitSet（条件等待队列）。

**锁升级：无锁 → 偏向锁 → 轻量级锁 → 重量级锁**

JDK 6 引入锁优化后，synchronized 的加锁过程是逐步升级的：

1. **无锁**：对象初始状态，Mark Word 存储 hashCode 和分代年龄。
2. **偏向锁**：第一个线程 CAS 将自己的线程 ID 写入 Mark Word。此后该线程每次进入同步块只需检查 Mark Word 中的线程 ID 是否是自己，无需 CAS，开销极低。若出现竞争，偏向锁撤销并升级。
3. **轻量级锁**：线程在栈帧中创建 Lock Record，CAS 尝试将 Mark Word 替换为指向 Lock Record 的指针。若 CAS 失败说明存在竞争，自旋若干次后升级为重量级锁。
4. **重量级锁**：依赖操作系统 Mutex，线程被挂起（阻塞），涉及用户态与内核态的切换，开销较大。

**synchronized 与 volatile 对比**

| 特性 | synchronized | volatile |
|------|-------------|----------|
| 原子性 | 保证 | 不保证 |
| 可见性 | 保证 | 保证 |
| 有序性 | 保证 | 保证（内存屏障） |
| 阻塞 | 会阻塞线程 | 不会阻塞 |
| 锁升级 | 支持 | 不适用 |
| 适用场景 | 临界区、方法同步 | 状态标志、DCL |

---

## 二、线程基础

### 2.1 线程的创建方式

Java 提供了三种创建线程的方式：

**方式一：继承 Thread 类**

```java
public class MyThread extends Thread {
    @Override
    public void run() {
        System.out.println("Thread running: " + Thread.currentThread().getName());
    }
}
new MyThread().start();
```

**方式二：实现 Runnable 接口**

```java
public class MyRunnable implements Runnable {
    @Override
    public void run() {
        System.out.println("Runnable running: " + Thread.currentThread().getName());
    }
}
new Thread(new MyRunnable()).start();
// 或 Lambda 简写
new Thread(() -> System.out.println("Lambda thread")).start();
```

**方式三：实现 Callable 接口（配合 FutureTask）**

```java
public class MyCallable implements Callable<Integer> {
    @Override
    public Integer call() throws Exception {
        int sum = 0;
        for (int i = 1; i <= 100; i++) sum += i;
        return sum;
    }
}

FutureTask<Integer> task = new FutureTask<>(new MyCallable());
new Thread(task).start();
Integer result = task.get(); // 阻塞等待结果
System.out.println("Sum = " + result);
```

**三种方式对比**

| 对比项 | Thread | Runnable | Callable |
|--------|--------|----------|----------|
| 创建方式 | 继承 | 实现接口 | 实现接口 |
| 多继承 | 不支持 | 支持 | 支持 |
| 返回值 | 无 | 无 | 有（Future） |
| 异常处理 | 不能抛出受检异常 | 不能抛出受检异常 | 可以抛出 |
| 推荐使用 | 不推荐 | 推荐 | 需要返回值时推荐 |

### 2.2 线程生命周期

Java 线程共有六种状态：

```
NEW ──start()──▶ RUNNABLE ──────────────────────────────▶ TERMINATED
                    │  ▲                                   ▲
       获取锁失败 │  │ 获取锁成功                           │ run()执行完毕
                    ▼  │                                   │
                 BLOCKED ──────────────────────────────────┘
                    │  ▲
      调用wait/join │  │ notify/超时
                    ▼  │
                WAITING ──▶ RUNNABLE
                    │
         带超时的   │
      wait/join/sleep
                    ▼
             TIMED_WAITING ──超时到期──▶ RUNNABLE
```

- **NEW**：线程对象已创建，尚未调用 `start()`。
- **RUNNABLE**：已调用 `start()`，包含操作系统层面的"运行中"和"就绪"两种状态。
- **BLOCKED**：等待获取锁（如进入 synchronized 块）。
- **WAITING**：调用了 `Object.wait()`、`Thread.join()` 或 `LockSupport.park()`，等待被唤醒。
- **TIMED_WAITING**：带超时的等待，如 `Thread.sleep(ms)`、`Object.wait(ms)`、`Thread.join(ms)`。
- **TERMINATED**：线程执行完毕。

### 2.3 线程间通信

**wait / notify / notifyAll**

这三个方法属于 `Object` 类，必须在 synchronized 块中使用：

```java
private final Object lock = new Object();
private boolean produced = false;

// 生产者
public void produce() {
    synchronized (lock) {
        while (produced) {
            lock.wait(); // 释放锁并等待
        }
        // 生产数据
        produced = true;
        lock.notifyAll(); // 唤醒所有等待线程
    }
}

// 消费者
public void consume() {
    synchronized (lock) {
        while (!produced) {
            lock.wait();
        }
        // 消费数据
        produced = false;
        lock.notifyAll();
    }
}
```

注意：`wait()` 应始终在 `while` 循环中调用，以防止虚假唤醒（Spurious Wakeup）。

**join 与 yield**

- `join()`：当前线程等待目标线程执行完毕，底层通过 `wait()` 实现。
- `yield()`：提示调度器当前线程愿意让出 CPU，但调度器可以忽略。

**ThreadLocal 原理与内存泄漏**

`ThreadLocal` 为每个线程提供独立的变量副本，底层依赖 `Thread` 类中的 `ThreadLocalMap`：

```java
// Thread 类内部
ThreadLocal.ThreadLocalMap threadLocals = null;

// ThreadLocalMap 的 Entry 继承自 WeakReference<ThreadLocal<?>>
static class Entry extends WeakReference<ThreadLocal<?>> {
    Object value;
    Entry(ThreadLocal<?> k, Object v) {
        super(k);  // key 是弱引用
        value = v; // value 是强引用
    }
}
```

**内存泄漏原因**：Entry 的 key 是弱引用，当 ThreadLocal 对象没有外部强引用时会被 GC 回收，导致 key 变为 null，但 value 仍然是强引用。如果线程长期存活（如线程池中的线程），value 将永远不会被回收。

**最佳实践**：使用完毕后务必调用 `remove()`。

```java
ThreadLocal<User> userHolder = new ThreadLocal<>();
try {
    userHolder.set(currentUser);
    // 业务逻辑
} finally {
    userHolder.remove(); // 防止内存泄漏
}
```

---

## 三、JUC 并发工具包

### 3.1 AQS（AbstractQueuedSynchronizer）

AQS 是 JUC 包的基石，ReentrantLock、CountDownLatch、Semaphore、ReentrantReadWriteLock 等工具均基于 AQS 实现。

**核心设计：state + CLH 变体队列**

```java
public abstract class AbstractQueuedSynchronizer {
    // 同步状态，不同子类有不同含义
    // ReentrantLock: 重入次数
    // Semaphore: 剩余许可数
    // CountDownLatch: 剩余计数
    private volatile int state;

    // 等待队列头节点
    private transient volatile Node head;
    // 等待队列尾节点
    private transient volatile Node tail;

    // CLH 变体队列的节点
    static final class Node {
        static final Node SHARED = new Node();
        static final Node EXCLUSIVE = null;
        static final int CANCELLED = 1;
        static final int SIGNAL = -1;
        static final int CONDITION = -2;

        volatile int waitStatus;
        volatile Node prev;
        volatile Node next;
        volatile Thread thread;
        Node nextWaiter; // 条件队列或共享模式标记
    }
}
```

AQS 的核心思想：维护一个 `volatile int state` 表示同步状态，通过 CAS 修改 state。当线程获取锁失败时，将线程封装为 Node 加入双向链表（CLH 变体），并通过 `LockSupport.park()` 挂起线程，等待前驱节点释放锁后被 `unpark()` 唤醒。

**独占模式与共享模式**

- **独占模式（Exclusive）**：同一时刻只有一个线程能获取锁，如 ReentrantLock。
- **共享模式（Shared）**：多个线程可同时获取，如 Semaphore、CountDownLatch。

**Condition 条件队列**

`Condition` 是 `Object.wait/notify` 的增强版，支持多条件等待、超时、中断：

```java
ReentrantLock lock = new ReentrantLock();
Condition notFull = lock.newCondition();
Condition notEmpty = lock.newCondition();

lock.lock();
try {
    while (队列已满) notFull.await();
    // 入队操作
    notEmpty.signal();
} finally {
    lock.unlock();
}
```

### 3.2 ReentrantLock

ReentrantLock 是 AQS 的直接实现，提供比 synchronized 更灵活的锁控制。

**公平锁与非公平锁**

```java
// 非公平锁（默认，吞吐量更高）
ReentrantLock unfairLock = new ReentrantLock();

// 公平锁（按请求顺序获取，减少饥饿）
ReentrantLock fairLock = new ReentrantLock(true);
```

非公平锁的核心逻辑——新线程获取锁时先直接 CAS 尝试插队，失败后才进入队列排队：

```java
// NonfairSync 源码简化
final void lock() {
    if (compareAndSetState(0, 1))       // 直接尝试获取锁
        setExclusiveOwnerThread(Thread.currentThread());
    else
        acquire(1);                      // 失败则排队
}

// FairSync 源码简化
final void lock() {
    acquire(1);                          // 老老实实排队
}

// acquire 中 FairSync 会额外判断：
protected final boolean tryAcquire(int acquires) {
    if (getState() == 0) {
        if (!hasQueuedPredecessors() &&   // 队列中没有等待更久的线程
            compareAndSetState(0, acquires)) {
            setExclusiveOwnerThread(Thread.currentThread());
            return true;
        }
    }
    // ...重入判断
}
```

**与 synchronized 对比**

| 特性 | ReentrantLock | synchronized |
|------|--------------|--------------|
| 实现层面 | JDK（java 层面） | JVM（native 层面） |
| 锁释放 | 手动 unlock（finally） | 自动释放 |
| 可中断 | 支持（lockInterruptibly） | 不支持 |
| 超时获取 | 支持（tryLock） | 不支持 |
| 公平锁 | 支持 | 不支持 |
| 多条件 | 支持（多个 Condition） | 只有一个 WaitSet |
| 性能 | JDK6 后差距不大 | JDK6 优化后接近 |

**实际使用模板**

```java
ReentrantLock lock = new ReentrantLock();

public void doSomething() {
    lock.lock();
    try {
        // 临界区操作
    } finally {
        lock.unlock(); // 必须在 finally 中释放锁
    }
}
```

### 3.3 读写锁 ReentrantReadWriteLock

读写锁允许多个读线程同时访问，但写操作是独占的，适合读多写少的场景。

```java
ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
ReadLock readLock = rwLock.readLock();
WriteLock writeLock = rwLock.writeLock();

// 读操作（多个线程可同时持有）
readLock.lock();
try {
    // 读取共享数据
} finally {
    readLock.unlock();
}

// 写操作（独占）
writeLock.lock();
try {
    // 修改共享数据
} finally {
    writeLock.unlock();
}
```

**锁降级**：写锁可以降级为读锁——在持有写锁的情况下获取读锁，然后释放写锁。注意反过来（读锁升级写锁）是不允许的，会导致死锁。

```java
writeLock.lock();
try {
    // 更新数据
    readLock.lock();  // 获取读锁（降级）
} finally {
    writeLock.unlock(); // 释放写锁，仍持有读锁
}
try {
    // 继续读取
} finally {
    readLock.unlock();
}
```

**StampedLock 简介**

JDK 8 引入的 `StampedLock` 是对 `ReentrantReadWriteLock` 的增强，支持乐观读模式：

```java
StampedLock sl = new StampedLock();
long stamp = sl.tryOptimisticRead(); // 不加锁，获取版本号
double x = this.x, y = this.y;       // 读取数据

if (!sl.validate(stamp)) {            // 检查期间是否有写操作
    stamp = sl.readLock();             // 乐观读失败，升级为悲观读锁
    try {
        x = this.x; y = this.y;
    } finally {
        sl.unlockRead(stamp);
    }
}
```

### 3.4 CountDownLatch / CyclicBarrier / Semaphore

**CountDownLatch**

让一个或多个线程等待其他线程完成一组操作后再继续。一次性使用，计数不可重置。

```java
int N = 5;
CountDownLatch latch = new CountDownLatch(N);

for (int i = 0; i < N; i++) {
    new Thread(() -> {
        try {
            Thread.sleep((long)(Math.random() * 1000));
            System.out.println(Thread.currentThread().getName() + " 完成");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            latch.countDown(); // 计数减一
        }
    }).start();
}

latch.await(); // 主线程等待计数归零
System.out.println("所有任务完成，主线程继续执行");
```

AQS 实现原理：state 初始值为计数 N，每次 `countDown()` 将 state 减 1，`await()` 的线程在 state > 0 时被挂入 AQS 队列，state 变为 0 时通过 doReleaseShared 唤醒所有等待线程。

**CyclicBarrier**

让一组线程互相等待，全部到达屏障点后再一起继续。可循环使用。

```java
int N = 3;
CyclicBarrier barrier = new CyclicBarrier(N, () -> {
    System.out.println("所有线程到达屏障，执行汇总操作");
});

for (int i = 0; i < N; i++) {
    new Thread(() -> {
        try {
            System.out.println(Thread.currentThread().getName() + " 到达屏障");
            barrier.await(); // 等待其他线程
            System.out.println(Thread.currentThread().getName() + " 继续执行");
        } catch (Exception e) {
            Thread.currentThread().interrupt();
        }
    }).start();
}
```

**Semaphore**

控制同时访问特定资源的线程数量，常用于限流。

```java
Semaphore semaphore = new Semaphore(3); // 最多3个线程同时访问

for (int i = 0; i < 10; i++) {
    new Thread(() -> {
        try {
            semaphore.acquire(); // 获取许可
            System.out.println(Thread.currentThread().getName() + " 获取许可，执行任务");
            Thread.sleep(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            semaphore.release(); // 释放许可
        }
    }).start();
}
```

---

## 四、并发容器

### 4.1 ConcurrentHashMap

**JDK 7：分段锁设计**

JDK 7 的 ConcurrentHashMap 由多个 Segment（默认 16 个）组成，每个 Segment 继承自 ReentrantLock，内部维护一个小的 HashEntry 数组。不同 Segment 上的操作互不阻塞，理论最大并发度为 Segment 数量。

```
ConcurrentHashMap
├── Segment[0]  (ReentrantLock)
│   ├── HashEntry[]
│   └── ...
├── Segment[1]
│   └── ...
└── ...Segment[15]
```

**JDK 8：CAS + synchronized + 红黑树**

JDK 8 彻底抛弃了分段锁，采用与 HashMap 相同的 `Node[] + 链表 + 红黑树` 结构，使用 CAS 和 synchronized 控制并发：

```java
// JDK 8 put 方法核心逻辑简化
final V putVal(K key, V value, boolean onlyIfAbsent) {
    int hash = spread(key.hashCode());
    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int n, i, fh;
        if (tab == null)
            initTable();                              // CAS 初始化
        else if ((f = tabAt(tab, i)) == null)
            casTabAt(tab, i, new Node<>(hash, key, value)); // CAS 插入空桶
        else {
            synchronized (f) {                        // 锁住链表/树的头节点
                // 链表或红黑树插入
                if (fh >= 0) { /* 链表操作 */ }
                else if (f instanceof TreeBin) { /* 红黑树操作 */ }
            }
        }
    }
}
```

**size() 如何保证准确**

JDK 8 使用 `baseCount + CounterCell[]` 的方式统计元素个数（类似 LongAdder 的分段思想）。`size()` 返回的是一个近似值（`mappingCount()` 方法返回 long），通过 `sumCount()` 将 baseCount 和所有 CounterCell 求和得到。

### 4.2 CopyOnWriteArrayList

写时复制策略：每次写操作时复制底层数组，在新数组上修改，完成后替换引用。读操作无锁。

```java
// JDK 源码 add 方法
public boolean add(E e) {
    final ReentrantLock lock = this.lock;
    lock.lock();
    try {
        Object[] elements = getArray();
        int len = elements.length;
        Object[] newElements = Arrays.copyOf(elements, len + 1); // 复制数组
        newElements[len] = e;
        setArray(newElements); // volatile 写，保证可见性
        return true;
    } finally {
        lock.unlock();
    }
}

// 读操作完全无锁
public E get(int index) {
    return get(getArray(), index);
}
```

**适用场景**：读多写极少的场景，如监听器列表、配置列表。写操作频繁时大量数组复制会导致严重的性能问题和内存开销。

### 4.3 BlockingQueue 系列

BlockingQueue 是生产者-消费者模式的核心抽象，提供阻塞式的入队和出队操作。

**ArrayBlockingQueue vs LinkedBlockingQueue**

| 对比项 | ArrayBlockingQueue | LinkedBlockingQueue |
|--------|-------------------|---------------------|
| 底层结构 | 数组 | 链表 |
| 有界/无界 | 必须有界 | 可有界，默认 Integer.MAX_VALUE |
| 锁 | 一把锁（ReentrantLock） | 两把锁（takeLock + putLock） |
| 吞吐量 | 较低 | 较高（双锁分离） |
| GC 压力 | 低（预分配数组） | 高（每次入队创建 Node） |

**生产者-消费者模式实现**

```java
BlockingQueue<String> queue = new ArrayBlockingQueue<>(10);

// 生产者
ExecutorService producerPool = Executors.newFixedThreadPool(2);
producerPool.submit(() -> {
    while (true) {
        String data = generateData();
        queue.put(data); // 队列满时阻塞
    }
});

// 消费者
ExecutorService consumerPool = Executors.newFixedThreadPool(3);
consumerPool.submit(() -> {
    while (true) {
        String data = queue.take(); // 队列空时阻塞
        processData(data);
    }
});
```

**其他队列**

- **DelayQueue**：元素需实现 `Delayed` 接口，只有延迟时间到期后才能取出，适用于定时任务调度、缓存过期清理。
- **PriorityBlockingQueue**：按优先级排序的无界队列，内部使用堆（数组）实现。

---

## 五、线程池

### 5.1 ThreadPoolExecutor 核心参数

```java
public ThreadPoolExecutor(
    int corePoolSize,        // 核心线程数（即使空闲也不回收，除非设置 allowCoreThreadTimeOut）
    int maximumPoolSize,     // 最大线程数
    long keepAliveTime,      // 非核心线程空闲存活时间
    TimeUnit unit,           // 时间单位
    BlockingQueue<Runnable> workQueue,     // 任务队列
    ThreadFactory threadFactory,           // 线程工厂
    RejectedExecutionHandler handler       // 拒绝策略
)
```

**任务提交流程**

1. 若当前线程数 < corePoolSize，直接创建新核心线程执行任务。
2. 若当前线程数 >= corePoolSize，将任务放入 workQueue。
3. 若 workQueue 已满且线程数 < maximumPoolSize，创建非核心线程执行任务。
4. 若线程数已达 maximumPoolSize 且队列已满，执行拒绝策略。

**workQueue 类型选择**

- `LinkedBlockingQueue`：无界队列（慎用，有 OOM 风险），适用于任务量波动较大的场景。
- `ArrayBlockingQueue`：有界队列，必须指定容量，推荐在生产环境使用。
- `SynchronousQueue`：不存储任务，每个 put 必须等待一个 take，适用于 CachedThreadPool。
- `PriorityBlockingQueue`：优先级队列，任务需实现 Comparable。

### 5.2 四种拒绝策略源码分析

```java
// 1. AbortPolicy（默认）：直接抛出异常
public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
    throw new RejectedExecutionException("Task " + r.toString() +
        " rejected from " + e.toString());
}

// 2. CallerRunsPolicy：由提交任务的线程自己执行
public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
    if (!e.isShutdown()) {
        r.run(); // 在当前调用者线程中同步执行
    }
}

// 3. DiscardPolicy：静默丢弃，什么也不做
public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
    // 空实现，任务被无声丢弃
}

// 4. DiscardOldestPolicy：丢弃队列头部的最老任务，重新提交当前任务
public void rejectedExecution(Runnable r, ThreadPoolExecutor e) {
    if (!e.isShutdown()) {
        e.getQueue().poll(); // 移除队列头部任务
        e.execute(r);        // 重新提交
    }
}
```

生产环境建议使用 `CallerRunsPolicy` 或自定义拒绝策略（如记录日志、将任务持久化到 MQ）。

### 5.3 线程池的合理配置

**CPU 密集型**：线程数 ≈ CPU 核心数 + 1。计算密集，线程切换开销大，不宜过多。

**IO 密集型**：线程数 ≈ CPU 核心数 × 2（或根据 IO 等待时间比例调整）。线程大部分时间在等待 IO，CPU 空闲，可适当增加线程数。

更精确的公式：`线程数 = CPU核心数 × (1 + 等待时间 / 计算时间)`

**动态调整线程池参数**

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(/* ... */);

// 运行时动态调整
pool.setCorePoolSize(20);
pool.setMaximumPoolSize(50);

// 自定义 ThreadFactory 便于排查问题
ThreadFactory namedFactory = r -> {
    Thread t = new Thread(r);
    t.setName("order-pool-" + t.getId());
    t.setDaemon(true);
    return t;
};
```

### 5.4 为什么不推荐 Executors 创建线程池

阿里巴巴 Java 开发手册明确规定：**线程池不允许使用 Executors 创建，而应通过 ThreadPoolExecutor 构造**。原因如下：

```java
// FixedThreadPool / SingleThreadPool
// 使用 LinkedBlockingQueue（无界队列），任务堆积可导致 OOM
public static ExecutorService newFixedThreadPool(int nThreads) {
    return new ThreadPoolExecutor(nThreads, nThreads,
        0L, TimeUnit.MILLISECONDS,
        new LinkedBlockingQueue<Runnable>()); // Integer.MAX_VALUE 容量！
}

// CachedThreadPool
// maximumPoolSize = Integer.MAX_VALUE，可能创建大量线程导致 OOM
public static ExecutorService newCachedThreadPool() {
    return new ThreadPoolExecutor(0, Integer.MAX_VALUE,
        60L, TimeUnit.SECONDS,
        new SynchronousQueue<Runnable>());
}

// ScheduledThreadPool
// 使用 DelayedWorkQueue（无界），同样有 OOM 风险
```

---

## 六、原子操作类

### 6.1 CAS 原理

CAS（Compare And Swap）是一条 CPU 原子指令，语义为：如果内存地址 V 的当前值为 A，则将其更新为 B，否则不做操作。

```
CAS(V, Expected, NewValue)
if V == Expected:
    V = NewValue
    return true
else:
    return false
```

Java 通过 `sun.misc.Unsafe` 类（JDK 9+ 迁移到 `jdk.internal.misc.Unsafe` 和 `VarHandle`）提供 CAS 操作：

```java
// Unsafe 中的 CAS 方法
public final native boolean compareAndSwapInt(Object o, long offset,
                                               int expected, int x);
public final native boolean compareAndSwapLong(Object o, long offset,
                                                long expected, long x);
public final native boolean compareAndSwapObject(Object o, long offset,
                                                  Object expected, Object x);
```

**ABA 问题与 AtomicStampedReference**

CAS 只检查值是否变化，不关心中间过程。假设线程 1 读取值 A，线程 2 将 A→B→A 改回，线程 1 的 CAS 会成功，但实际上值已被修改过。这就是 ABA 问题。

解决方案：使用 `AtomicStampedReference`，在值的基础上增加版本号（stamp）：

```java
AtomicStampedReference<Integer> ref = new AtomicStampedReference<>(100, 0);
int stamp = ref.getStamp();

// CAS 时同时检查值和版本号
ref.compareAndSet(100, 200, stamp, stamp + 1);
```

### 6.2 AtomicInteger 源码分析

```java
public class AtomicInteger extends Number implements java.io.Serializable {
    private static final Unsafe unsafe = Unsafe.getUnsafe();
    private static final long valueOffset; // value 字段在对象中的偏移量

    static {
        valueOffset = unsafe.objectFieldOffset(
            AtomicInteger.class.getDeclaredField("value"));
    }

    private volatile int value; // 用 volatile 保证可见性

    public final int getAndIncrement() {
        return unsafe.getAndAddInt(this, valueOffset, 1);
    }

    // getAndAddInt 的自旋实现
    public final int getAndAddInt(Object o, long offset, int delta) {
        int v;
        do {
            v = getIntVolatile(o, offset); // 读取当前值
        } while (!compareAndSwapInt(o, offset, v, v + delta)); // CAS 更新
        return v;
    }

    public final int incrementAndGet() {
        return unsafe.getAndAddInt(this, valueOffset, 1) + 1;
    }
}
```

### 6.3 LongAdder vs AtomicLong

在高并发场景下，`AtomicLong` 的 CAS 竞争激烈，大量线程自旋导致 CPU 空转。`LongAdder`（JDK 8）采用分段 CAS 策略优化：

```java
public class LongAdder extends Striped64 implements Serializable {
    // 基础值
    transient volatile long base;
    // Cell 数组（分段）
    transient volatile Cell[] cells;

    public void add(long x) {
        Cell[] as; long b, v; int m; Cell a;
        if ((as = cells) != null || !casBase(b = base, b + x)) {
            // cells 不为空或 base CAS 失败，进入分段逻辑
            boolean uncontended = true;
            // 根据线程 hash 选择一个 Cell 进行 CAS
            // 若仍然失败，则扩容 cells 数组
        }
    }

    public long sum() {
        Cell[] as = cells; Cell a;
        long sum = base;
        if (as != null) {
            for (int i = 0; i < as.length; ++i) {
                if ((a = as[i]) != null)
                    sum += a.value;
            }
        }
        return sum;
    }
}
```

`LongAdder` 将竞争分散到多个 Cell 中，每个线程对不同 Cell 做 CAS，大幅减少冲突。代价是 `sum()` 不是强一致的（遍历过程中可能有其他线程在修改），适用于统计计数场景。

---

## 七、CompletableFuture 异步编程

JDK 8 引入的 `CompletableFuture` 是对 `Future` 的增强，支持链式调用、组合、异常处理，彻底解决了 `Future.get()` 阻塞等待的问题。

### 7.1 创建异步任务

```java
// 无返回值
CompletableFuture<Void> cf1 = CompletableFuture.runAsync(() -> {
    System.out.println("异步任务执行: " + Thread.currentThread().getName());
});

// 有返回值
CompletableFuture<String> cf2 = CompletableFuture.supplyAsync(() -> {
    // 耗时操作
    return "结果数据";
});

// 指定线程池（推荐在生产环境中指定）
ExecutorService pool = Executors.newFixedThreadPool(4);
CompletableFuture<String> cf3 = CompletableFuture.supplyAsync(() -> {
    return queryFromDatabase();
}, pool);
```

### 7.2 链式调用与组合

```java
// thenApply: 同步转换（类似 map）
CompletableFuture<Integer> lengthFuture = CompletableFuture
    .supplyAsync(() -> "Hello World")
    .thenApply(String::length);

// thenCompose: 扁平化（类似 flatMap）
CompletableFuture<String> composed = CompletableFuture
    .supplyAsync(() -> "userId-123")
    .thenCompose(userId -> CompletableFuture.supplyAsync(() -> "User:" + userId));

// thenCombine: 组合两个独立的 Future
CompletableFuture<String> combined = CompletableFuture
    .supplyAsync(() -> "Hello")
    .thenCombine(
        CompletableFuture.supplyAsync(() -> " World"),
        (s1, s2) -> s1 + s2
    );

// allOf: 等待所有任务完成
CompletableFuture<Void> all = CompletableFuture.allOf(cf1, cf2, cf3);
all.thenRun(() -> System.out.println("所有任务完成"));

// anyOf: 任一任务完成即返回
CompletableFuture<Object> any = CompletableFuture.anyOf(cf1, cf2, cf3);
any.thenAccept(result -> System.out.println("最快完成的任务结果: " + result));
```

### 7.3 异常处理

```java
CompletableFuture<String> cf = CompletableFuture
    .supplyAsync(() -> {
        if (true) throw new RuntimeException("查询失败");
        return "data";
    })
    .exceptionally(ex -> {
        // 异常兜底，类似 catch
        System.err.println("异常: " + ex.getMessage());
        return "默认值";
    });

// 更精细的处理：handle 可以同时处理正常结果和异常
CompletableFuture<String> handled = CompletableFuture
    .supplyAsync(() -> riskyOperation())
    .handle((result, ex) -> {
        if (ex != null) {
            return "降级数据";
        }
        return result;
    });

// whenComplete: 类似 finally，不改变结果
CompletableFuture<String> logged = CompletableFuture
    .supplyAsync(() -> fetchData())
    .whenComplete((result, ex) -> {
        if (ex != null) {
            log.error("任务失败", ex);
        } else {
            log.info("任务成功: {}", result);
        }
    });
```

### 7.4 实际应用场景

**并行查询多个服务并聚合结果**

```java
public ProductDetail getProductDetail(Long productId) {
    CompletableFuture<ProductInfo> infoFuture = CompletableFuture
        .supplyAsync(() -> productService.getInfo(productId), pool);

    CompletableFuture<List<Review>> reviewFuture = CompletableFuture
        .supplyAsync(() -> reviewService.getReviews(productId), pool);

    CompletableFuture<PriceInfo> priceFuture = CompletableFuture
        .supplyAsync(() -> priceService.getPrice(productId), pool);

    // 等待所有结果并聚合
    return CompletableFuture.allOf(infoFuture, reviewFuture, priceFuture)
        .thenApply(v -> {
            ProductDetail detail = new ProductDetail();
            detail.setInfo(infoFuture.join());
            detail.setReviews(reviewFuture.join());
            detail.setPrice(priceFuture.join());
            return detail;
        })
        .orTimeout(3, TimeUnit.SECONDS) // JDK 9+，超时控制
        .exceptionally(ex -> {
            // 降级处理
            return ProductDetail.empty();
        })
        .join();
}
```

---

## 八、并发编程面试题精选

**1. 说说你对 volatile 关键字的理解？**

volatile 保证可见性和有序性，不保证原子性。通过内存屏障实现：写操作后插入 StoreStore + StoreLoad 屏障，读操作前插入 LoadLoad + LoadStore 屏障。适用于状态标志位和 DCL 单例。

**2. synchronized 和 ReentrantLock 的区别是什么？**

synchronized 是 JVM 层面的关键字，自动释放锁；ReentrantLock 是 JDK 的 API 层面实现，需要手动 lock/unlock。ReentrantLock 额外支持公平锁、可中断、超时获取、多条件变量。JDK 6 之后 synchronized 经过锁升级优化，性能差距已大幅缩小。

**3. 线程池的核心参数有哪些？任务提交后的执行流程是什么？**

核心参数包括 corePoolSize、maximumPoolSize、keepAliveTime、workQueue、threadFactory、handler。执行流程：先看核心线程→再入队列→队列满看最大线程→都满则拒绝。

**4. ConcurrentHashMap 如何实现线程安全？**

JDK 7 采用分段锁（Segment），JDK 8 改用 CAS + synchronized 锁住链表头节点，粒度更细。size 统计使用 baseCount + CounterCell[] 的分段计数方案。

**5. 什么是 ABA 问题？如何解决？**

CAS 只比较值是否变化，不感知中间状态改变。AtomicStampedReference 通过引入版本号（stamp），每次更新 stamp 加一，CAS 时同时检查值和版本号。

**6. ThreadLocal 为什么会导致内存泄漏？**

ThreadLocalMap 的 Entry 中 key 是弱引用，value 是强引用。当 ThreadLocal 被回收后 key 变为 null，但 value 仍被线程强引用，无法回收。解决方案：使用完毕调用 `remove()`。

**7. CountDownLatch 和 CyclicBarrier 的区别？**

CountDownLatch 是一个线程等待多个线程完成（一次性），基于 AQS 共享模式实现。CyclicBarrier 是多个线程互相等待到齐后一起执行（可循环复用），内部使用 ReentrantLock 实现。

**8. 为什么 DCL 单例需要 volatile？**

`new` 操作包含分配内存、初始化对象、赋值引用三步，步骤 2 和 3 可能重排序。不加 volatile 可能导致其他线程拿到未初始化完成的对象。volatile 通过禁止重排序解决此问题。

**9. AtomicLong 和 LongAdder 有什么区别？**

AtomicLong 通过单一 CAS 更新，高并发下竞争激烈。LongAdder 采用分段 CAS（Cell 数组），将竞争分散到不同 Cell，sum() 时求和。适用于高并发计数场景，但 sum() 不是强一致的。

**10. CompletableFuture 相比 Future 有什么优势？**

Future 只能阻塞等待结果（`get()`），无法链式组合和异常处理。CompletableFuture 支持 thenApply/thenCompose/thenCombine 链式调用、allOf/anyOf 组合、exceptionally/handle 异常处理，以及 orTimeout 超时控制，极大提升了异步编程的表达能力。

---

## 总结

Java 并发编程的知识体系庞大而精密。从底层的 JMM 内存模型到上层的 CompletableFuture 异步框架，每一层都在解决特定的并发问题：

- **JMM + volatile + synchronized** 解决了可见性、有序性和基本同步问题；
- **AQS** 为 JUC 工具提供了统一的基础设施；
- **ReentrantLock / ReadWriteLock / StampedLock** 提供了灵活的锁策略；
- **并发容器** 在各自场景下实现了高效的线程安全访问；
- **线程池** 是生产环境中管理线程资源的标准方式；
- **原子类** 通过 CAS 实现了无锁并发；
- **CompletableFuture** 让异步编程变得优雅而强大。

理解这些工具的原理和适用场景，不仅能帮助我们在面试中脱颖而出，更重要的是能在实际开发中写出正确、高效的并发代码。并发编程没有银弹，选择合适的工具才是关键。
