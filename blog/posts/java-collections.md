# Java 集合框架源码深度分析——从 HashMap 到并发容器

> 本文基于 JDK 8u301 源码，深入剖析 Java 集合框架的核心实现。阅读前建议具备基本数据结构知识。

## 引言

Java 集合框架是每位 Java 开发者日常使用最频繁的 API 之一，但大多数人只停留在"会用"的层面，鲜少深入其源码。理解集合框架的设计思想，不仅能帮助我们写出更高效的代码，更是面试中的高频考点。

集合框架的整体架构可以用一句话概括：**以 `Collection` 和 `Map` 为两大基石，以 `Iterator` 为统一遍历协议**。

```
                    集合框架两大体系
                    ┌────────────────────────────────────┐
                    │                                    │
               Collection                          Map（键值对）
              /    |    \                          /         \
           List  Set  Queue                  HashMap    TreeMap
          /      |      |                   /      \        |
   ArrayList  HashSet  PriorityQueue  LinkedHashMap  ConcurrentHashMap
        |        |
  LinkedList  TreeSet
```

Collection 接口定义了单列元素的集合操作，而 Map 接口定义键值对的映射操作。两者在设计上完全分离，这是因为键值对的数据语义与单列元素有本质不同——Map 的键必须唯一，且操作维度是"通过键访问值"，而非"遍历元素"。

## 一、集合框架体系结构

### 1.1 Collection 接口族

Collection 接口是单列集合的根接口，它派生出三个主要分支：

**List（列表）**：有序、可重复的集合。元素有明确的索引位置，可以通过 `get(index)` 随机访问。典型实现有 `ArrayList` 和 `LinkedList`。

**Set（集合）**：无序、不可重复的集合。通过 `equals()` 和 `hashCode()` 保证元素唯一性。典型实现有 `HashSet` 和 `TreeSet`。

**Queue（队列）**：按照特定规则组织元素的集合。`LinkedList` 同时实现了 `Deque` 接口，`PriorityQueue` 基于堆实现优先级队列。

```java
// Collection 接口核心方法（简化）
public interface Collection<E> extends Iterable<E> {
    int size();
    boolean isEmpty();
    boolean contains(Object o);
    Iterator<E> iterator();
    boolean add(E e);
    boolean remove(Object o);
    void clear();
    // ...
}
```

### 1.2 Map 接口

Map 定义键到值的映射关系，键不可重复。注意 Map **不继承** Collection 接口，这是有意为之的设计：Collection 的核心语义是"一组元素"，而 Map 的核心语义是"关联关系"，两者的操作模式差异过大，强行继承只会造成接口混乱。

```java
public interface Map<K, V> {
    V get(Object key);
    V put(K key, V value);
    V remove(Object key);
    boolean containsKey(Object key);
    Set<K> keySet();          // 返回键的 Set 视图
    Collection<V> values();   // 返回值的 Collection 视图
    Set<Map.Entry<K, V>> entrySet(); // 返回键值对的 Set 视图
}
```

Map 通过 `keySet()`、`values()`、`entrySet()` 方法将自身"投影"为 Collection 视图，巧妙地实现了与 Collection 框架的桥接，而不需要继承关系。

### 1.3 Iterator 与 Iterable

迭代器模式是集合框架的统一遍历协议。`Iterable` 接口只有一个方法 `iterator()`，返回 `Iterator` 对象。

```java
public interface Iterable<T> {
    Iterator<T> iterator();
}

public interface Iterator<E> {
    boolean hasNext();
    E next();
    default void remove() { throw new UnsupportedOperationException(); }
}
```

**fail-fast 机制**：`ArrayList`、`HashMap` 等类维护一个 `modCount` 计数器，每次结构性修改（增删元素）时递增。迭代器在创建时记录 `expectedModCount = modCount`，每次 `next()` 时检查两者是否一致。若不一致，立即抛出 `ConcurrentModificationException`。这是一种"尽早失败"的设计，避免在并发修改下产生难以排查的错误。

**fail-safe 机制**：`CopyOnWriteArrayList`、`ConcurrentHashMap` 的迭代器不会抛出此异常。前者通过写时复制实现，后者通过弱一致性快照实现。代价是迭代器可能看不到最新的修改。

---

## 二、ArrayList 源码分析

### 2.1 底层数据结构

ArrayList 的核心是一个动态数组。JDK 8 源码如下：

```java
public class ArrayList<E> extends AbstractList<E>
    implements List<E>, RandomAccess, Cloneable, Serializable {

    // 默认空数组，用于未指定容量时的初始状态
    private static final Object[] EMPTY_ELEMENTDATA = {};

    // 默认容量的空数组（与 EMPTY_ELEMENTDATA 区分，用于第一次 add 时扩容到 10）
    private static final Object[] DEFAULTCAPACITY_EMPTY_ELEMENTDATA = {};

    // 存储元素的数组，transient 表示不参与序列化（自定义 writeObject）
    transient Object[] elementData;

    // 实际元素个数
    private int size;

    // 默认容量
    private static final int DEFAULT_CAPACITY = 10;
}
```

注意 `elementData` 被 `transient` 修饰，这是因为 ArrayList 内部数组的实际长度通常大于 `size`，直接序列化会浪费空间。ArrayList 自定义了 `writeObject` 方法，只序列化前 `size` 个元素。

### 2.2 扩容机制

当调用 `add()` 时，首先确保容量足够：

```java
public boolean add(E e) {
    ensureCapacityInternal(size + 1);  // 确保容量
    elementData[size++] = e;
    return true;
}

private void ensureCapacityInternal(int minCapacity) {
    // 如果是默认空数组，取 DEFAULT_CAPACITY(10) 和 minCapacity 的较大值
    if (elementData == DEFAULTCAPACITY_EMPTY_ELEMENTDATA) {
        minCapacity = Math.max(DEFAULT_CAPACITY, minCapacity);
    }
    ensureExplicitCapacity(minCapacity);
}

private void ensureExplicitCapacity(int minCapacity) {
    modCount++;  // 结构性修改，用于 fail-fast
    if (minCapacity - elementData.length > 0)
        grow(minCapacity);  // 需要扩容
}
```

核心的 `grow()` 方法：

```java
private void grow(int minCapacity) {
    int oldCapacity = elementData.length;
    // >> 1 等价于除以 2，即扩容为原来的 1.5 倍
    int newCapacity = oldCapacity + (oldCapacity >> 1);
    if (newCapacity - minCapacity < 0)
        newCapacity = minCapacity;
    if (newCapacity - MAX_ARRAY_SIZE > 0)
        newCapacity = hugeCapacity(minCapacity);
    // 核心：复制数组，代价 O(n)
    elementData = Arrays.copyOf(elementData, newCapacity);
}
```

扩容策略是 **1.5 倍增长**。为什么不是 2 倍？这与内存分配策略有关。假设当前容量为 N，扩容为 2N，那么释放掉的旧数组大小为 N，新数组大小为 2N，旧的 N 空间无法被新数组复用。而 1.5 倍增长，经过若干次扩容后，之前释放的空间有可能被复用（与 Fibonacci 数列的增长特性相关）。

```
扩容过程示意：
初始容量:  [0][1][2][3][4][5][6][7][8][9]  (10)
第1次扩容: [0][1][2][3][4][5][6][7][8][9][10][11][12][13][14]  (15)
第2次扩容: [0]...[21]  (22)
```

### 2.3 add/remove/get 时间复杂度

| 操作 | 平均时间复杂度 | 说明 |
|------|--------------|------|
| `get(index)` | O(1) | 数组随机访问 |
| `add(e)` | 摊还 O(1) | 大多数情况直接追加，偶尔触发 O(n) 扩容 |
| `add(index, e)` | O(n) | 需要 `System.arraycopy` 移动后续元素 |
| `remove(index)` | O(n) | 需要移动后续元素填补空缺 |
| `contains(o)` | O(n) | 线性遍历 |

### 2.4 SubList 的坑

`subList()` 返回的不是新列表，而是原列表的一个视图：

```java
public List<E> subList(int fromIndex, int toIndex) {
    return new SubList<>(this, offset, fromIndex, toIndex);
}

// SubList 内部类持有原列表的引用
private class SubList<E> extends AbstractList<E> implements RandomAccess {
    private final AbstractList<E> parent;  // 持有原列表引用！
    private int parentModCount;            // 记录创建时原列表的 modCount
    // ...
}
```

**陷阱**：修改原列表后，SubList 的迭代器会失效：

```java
List<Integer> list = new ArrayList<>(Arrays.asList(1, 2, 3, 4, 5));
List<Integer> sub = list.subList(1, 3);  // [2, 3]
list.add(6);  // 修改原列表
sub.forEach(System.out::println);  // 抛出 ConcurrentModificationException！
```

反之亦然：修改 SubList 会影响原列表，因为它们共享同一份 `elementData`。

---

## 三、LinkedList 源码分析

### 3.1 双向链表结构

LinkedList 的底层是双向链表，每个节点包含前驱、后继和元素值：

```java
public class LinkedList<E> extends AbstractSequentialList<E>
    implements List<E>, Deque<E>, Cloneable, Serializable {

    transient int size = 0;
    transient Node<E> first;  // 头指针
    transient Node<E> last;   // 尾指针

    private static class Node<E> {
        E item;
        Node<E> next;
        Node<E> prev;

        Node(Node<E> prev, E element, Node<E> next) {
            this.item = element;
            this.next = next;
            this.prev = prev;
        }
    }
}
```

双向链表结构示意：

```
        first                                    last
          ↓                                        ↓
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ null← A →│←──→│← B →│←──→│← C →null│
    └──────────┘    └──────────┘    └──────────┘
        prev|item|next  prev|item|next  prev|item|next
```

### 3.2 作为 Deque 使用

LinkedList 同时实现了 `Deque` 接口，可以作为双端队列使用：

```java
// 头部添加
public void addFirst(E e) {
    linkFirst(e);
}

private void linkFirst(E e) {
    final Node<E> f = first;
    final Node<E> newNode = new Node<>(null, e, f);
    first = newNode;
    if (f == null)
        last = newNode;
    else
        f.prev = newNode;
    size++;
    modCount++;
}

// 尾部移除
public E pollLast() {
    final Node<E> l = last;
    return (l == null) ? null : unlinkLast(l);
}
```

### 3.3 ArrayList vs LinkedList

**常见误解**："LinkedList 插入删除是 O(1)，比 ArrayList 快。"

**真相**：这个说法忽略了定位成本。在指定位置插入时，LinkedList 需要先遍历到目标位置，时间复杂度为 O(n)。只有在头部/尾部操作，或者已经持有节点引用时，LinkedList 的插入才是 O(1)。

```java
// LinkedList 的 add(index, element) 需要先定位
public void add(int index, E element) {
    if (index == size)
        linkLast(element);
    else
        linkBefore(element, node(index));  // node(index) 需要 O(n) 遍历！
}

// node() 方法：从头或从尾遍历，取较短路径
Node<E> node(int index) {
    if (index < (size >> 1)) {  // 前半段从头遍历
        Node<E> x = first;
        for (int i = 0; i < index; i++) x = x.next;
        return x;
    } else {  // 后半段从尾遍历
        Node<E> x = last;
        for (int i = size - 1; i > index; i--) x = x.prev;
        return x;
    }
}
```

**实测性能对比**（随机访问场景）：

```java
List<Integer> arrayList = new ArrayList<>();
List<Integer> linkedList = new LinkedList<>();
// 各添加 10 万个元素...

// get(50000) 耗时对比：
// ArrayList: ~0ms（数组直接寻址）
// LinkedList: ~1ms（需要遍历 5 万个节点）
```

此外，LinkedList 的每个节点需要额外存储 `prev` 和 `next` 两个引用，内存开销是 ArrayList 的 3 倍以上。加之 CPU 缓存行对连续内存更友好，ArrayList 在实际场景下几乎总是更快。**除非有明确的头尾操作需求，否则优先选择 ArrayList。**

---

## 四、HashMap 源码深度分析（重点）

HashMap 是集合框架中最复杂、面试频率最高的类。本节将深入其每一个关键实现。

### 4.1 数据结构演进

```
JDK 7: 数组 + 链表
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │   ← Entry[] table
└─┬─┴───┴─┬─┴───┴───┴───┴───┴───┘
  │       │
 [K,V]   [K,V]                    ← 链表节点（Entry）
  │
 [K,V]                            ← hash冲突形成的链表

JDK 8: 数组 + 链表 + 红黑树
┌───┬───┬───┬───┬───┬───┬───┬───┐
│ 0 │ 1 │ 2 │ 3 │ 4 │ 5 │ 6 │ 7 │   ← Node[] table
└─┬─┴───┴─┬─┴───┴───┴───┴───┴───┘
  │       │
 [K,V]   [K,V]                    ← 链表（长度 < 8）
  │        │
 [K,V]   [K,V]                   ← 链表（长度 < 8）
           │
        [K,V]
        /   \
     [K,V] [K,V]                 ← 红黑树（长度 ≥ 8 且 table ≥ 64）
      / \
  [K,V] [K,V]
```

### 4.2 哈希计算

HashMap 的 `hash()` 方法是一个扰动函数：

```java
static final int hash(Object key) {
    int h;
    // 高 16 位与低 16 位异或，增加低位的随机性
    return (key == null) ? 0 : (h = key.hashCode()) ^ (h >>> 16);
}
```

**为什么用高 16 位异或低 16 位？**

HashMap 定位桶的公式是 `(n - 1) & hash`，其中 n 是数组长度，且 n 必须是 2 的幂。这意味着只有 hash 值的低位参与索引计算。如果 hashCode 的低位分布不均匀（比如 Integer 的 hashCode 就是其值本身），会导致大量冲突。

```
假设 hashCode = 0x12345678，n = 16（二进制 00010000）

原始 hashCode:    0001 0010 0011 0100 0101 0110 0111 1000
>>> 16:           0000 0000 0000 0000 0001 0010 0011 0100
XOR 结果:         0001 0010 0011 0100 0100 0100 0100 1100

n - 1 = 15:       0000 0000 0000 0000 0000 0000 0000 1111
(n-1) & hash:     0000 0000 0000 0000 0000 0000 0000 1100  = 12
```

通过将高位信息"混入"低位，即使数组很小（只用到少数低位），也能让高位的差异影响到桶的分布，减少冲突。

### 4.3 put() 完整流程

```java
public V put(K key, V value) {
    return putVal(hash(key), key, value, false, true);
}

final V putVal(int hash, K key, V value, boolean onlyIfAbsent, boolean evict) {
    Node<K,V>[] tab; Node<K,V> p; int n, i;

    // 步骤1: table 未初始化，执行 resize()
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;

    // 步骤2: 计算桶索引，桶为空直接放入
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);
    else {
        // 步骤3: 桶不为空，需要处理冲突
        Node<K,V> e; K k;
        // 3a: 头节点就是目标 key，覆盖 value
        if (p.hash == hash &&
            ((k = p.key) == key || (key != null && key.equals(k))))
            e = p;
        // 3b: 已经是红黑树，走红黑树插入
        else if (p instanceof TreeNode)
            e = ((TreeNode<K,V>)p).putTreeVal(this, tab, hash, key, value);
        // 3c: 链表遍历
        else {
            for (int binCount = 0; ; ++binCount) {
                if ((e = p.next) == null) {
                    p.next = newNode(hash, key, value, null);
                    // 链表长度达到阈值，尝试树化
                    if (binCount >= TREEIFY_THRESHOLD - 1)
                        treeifyBin(tab, hash);
                    break;
                }
                if (e.hash == hash &&
                    ((k = e.key) == key || (key != null && key.equals(k))))
                    break;
                p = e;
            }
        }
        // 步骤4: 找到已存在的 key，覆盖 value
        if (e != null) {
            V oldValue = e.value;
            if (!onlyIfAbsent || oldValue == null)
                e.value = value;
            afterNodeAccess(e);  // LinkedHashMap 的回调
            return oldValue;
        }
    }
    // 步骤5: 修改计数，检查是否需要扩容
    ++modCount;
    if (++size > threshold)
        resize();
    afterNodeInsertion(evict);  // LinkedHashMap 的回调
    return null;
}
```

### 4.4 扩容机制 resize()

HashMap 的扩容策略是 **2 倍增长**，这是为了配合 `(n-1) & hash` 的索引计算方式。

```java
final Node<K,V>[] resize() {
    Node<K,V>[] oldTab = table;
    int oldCap = (oldTab == null) ? 0 : oldTab.length;
    int oldThr = threshold;
    int newCap, newThr = 0;

    if (oldCap > 0) {
        if (oldCap >= MAXIMUM_CAPACITY) {
            threshold = Integer.MAX_VALUE;
            return oldTab;
        }
        // 容量翻倍
        else if ((newCap = oldCap << 1) < MAXIMUM_CAPACITY &&
                 oldCap >= DEFAULT_INITIAL_CAPACITY)
            newThr = oldThr << 1; // 阈值也翻倍
    }
    // ... 初始化逻辑 ...

    threshold = newThr;
    Node<K,V>[] newTab = (Node<K,V>[])new Node[newCap];
    table = newTab;

    if (oldTab != null) {
        for (int j = 0; j < oldCap; ++j) {
            Node<K,V> e;
            if ((e = oldTab[j]) != null) {
                oldTab[j] = null;  // 帮助 GC
                if (e.next == null)
                    // 单节点：直接重新计算位置
                    newTab[e.hash & (newCap - 1)] = e;
                else if (e instanceof TreeNode)
                    ((TreeNode<K,V>)e).split(this, newTab, j, oldCap);
                else {
                    // 链表：高低位拆分
                    Node<K,V> loHead = null, loTail = null;  // 低位链
                    Node<K,V> hiHead = null, hiTail = null;  // 高位链
                    Node<K,V> next;
                    do {
                        next = e.next;
                        // 关键判断：hash 值在 oldCap 位上是 0 还是 1
                        if ((e.hash & oldCap) == 0) {
                            // 低位：位置不变（仍在索引 j）
                            if (loTail == null) loHead = e;
                            else loTail.next = e;
                            loTail = e;
                        } else {
                            // 高位：位置变为 j + oldCap
                            if (hiTail == null) hiHead = e;
                            else hiTail.next = e;
                            hiTail = e;
                        }
                    } while ((e = next) != null);

                    if (loTail != null) { loTail.next = null; newTab[j] = loHead; }
                    if (hiTail != null) { hiTail.next = null; newTab[j + oldCap] = hiHead; }
                }
            }
        }
    }
    return newTab;
}
```

**高低位拆分的核心思想**：

```
假设 oldCap = 16, 扩容后 newCap = 32
对于 hash = 20 的节点：

oldCap 二进制:    0001 0000
hash  二进制:     0001 0100
hash & oldCap:   0001 0000 != 0  →  高位链
→ 新位置 = 原位置(j=4) + oldCap(16) = 20

对于 hash = 4 的节点：
hash  二进制:     0000 0100
hash & oldCap:   0000 0000 == 0  →  低位链
→ 新位置 = 原位置(j=4)，不变
```

这个设计的精妙之处在于：扩容后，每个节点要么留在原位置，要么移动到 `原位置 + oldCap`，不需要重新计算完整索引。这保证了链表内部的相对顺序不变，且只需一次判断即可分流。

**为什么容量必须是 2 的幂？** 因为只有当 n = 2^k 时，`n - 1` 的二进制才是全 1（如 15 = 1111），`(n-1) & hash` 才能等价于 `hash % n`，同时位运算比取模运算快得多。

### 4.5 树化与退化

```java
// 链表树化阈值
static final int TREEIFY_THRESHOLD = 8;
// 红黑树退化阈值
static final int UNTREEIFY_THRESHOLD = 6;
// 树化所需的最小数组长度
static final int MIN_TREEIFY_CAPACITY = 64;
```

**树化条件**：链表长度 >= 8 **且** 数组长度 >= 64。如果数组长度不足 64，优先扩容而非树化。

**为什么是 8 和 6？为什么有差值？**

源码注释给出了答案：在理想的哈希分布下，链表长度服从泊松分布（参数 λ=0.5）。链表长度达到 8 的概率约为 0.00000006，几乎不可能。树化只是极端情况下的保底策略。

选择 6 作为退化阈值而非 8，是为了**避免频繁转换**（滞后效应）。如果树化和退化都用 8，那么在长度 7-8 边界反复增删时会频繁触发树化/退化，造成性能抖动。

```
泊松分布概率（λ=0.5）：
长度 0: 0.6065
长度 1: 0.3033
长度 2: 0.0758
长度 3: 0.0126
长度 4: 0.0016
长度 5: 0.0002
长度 6: 0.000012
长度 7: 0.0000009
长度 8: 0.00000006   ← 树化阈值，概率极低
```

### 4.6 线程安全问题

**并发 put 导致数据覆盖**：

```java
// 两个线程同时执行 put()
// 线程 A 和 B 都检测到桶为空，然后都执行 tab[i] = newNode(...)
// 后执行的线程覆盖先执行的结果，数据丢失
if ((p = tab[i = (n - 1) & hash]) == null)
    tab[i] = newNode(hash, key, value, null);  // 非原子操作！
```

**JDK 7 的死循环问题**：JDK 7 使用头插法，在并发扩容时，两个线程可能互相引用对方的节点，形成环形链表，导致后续 `get()` 死循环。

```
线程 A 扩容到一半被挂起：
节点 A → B → null

线程 B 完成扩容（头插法）：
B → A → null

线程 A 恢复执行（头插法）：
A → B → A → B → ...  形成环！
```

**JDK 8 改为尾插法**：扩容时保持链表的原始顺序，避免了环形链表问题。但这并不能解决所有并发问题——并发 put 仍然可能导致数据丢失。需要线程安全时，请使用 `ConcurrentHashMap`。

---

## 五、ConcurrentHashMap 源码分析

### 5.1 JDK 7: 分段锁（Segment）

JDK 7 的 ConcurrentHashMap 采用分段锁设计：

```java
// JDK 7 核心结构
static final class Segment<K,V> extends ReentrantLock implements Serializable {
    transient volatile HashEntry<K,V>[] table;
    transient int count;
}

// 默认 16 个 Segment
final Segment<K,V>[] segments;
```

```
Segment[0]  ──→ [HashEntry数组]   ← 锁0
Segment[1]  ──→ [HashEntry数组]   ← 锁1
Segment[2]  ──→ [HashEntry数组]   ← 锁2
...
Segment[15] ──→ [HashEntry数组]   ← 锁15
```

每个 Segment 是一个独立的小型 HashMap，自带 ReentrantLock。不同 Segment 的操作互不影响，理论最大并发度为 16。缺点是：Segment 数量在构造时确定，无法动态调整；且一个 Segment 内的所有桶共享同一把锁，锁粒度较粗。

### 5.2 JDK 8: CAS + synchronized

JDK 8 完全抛弃了 Segment，采用与 HashMap 相同的 Node 数组结构，但通过 CAS 和 synchronized 实现细粒度锁。

```java
public class ConcurrentHashMap<K,V> extends AbstractMap<K,V>
    implements ConcurrentMap<K,V>, Serializable {

    // volatile 保证可见性
    transient volatile Node<K,V>[] table;

    // 用于 size() 的计数器
    private transient volatile long baseCount;
    private transient volatile CounterCell[] counterCells;
}
```

**putVal() 流程详解**：

```java
final V putVal(K key, V value, boolean onlyIfAbsent) {
    if (key == null || value == null) throw new NullPointerException();
    int hash = spread(key.hashCode());
    int binCount = 0;

    for (Node<K,V>[] tab = table;;) {
        Node<K,V> f; int n, i, fh;

        // 1. table 未初始化，执行 initTable()（CAS 设置 sizeCtl）
        if (tab == null || (n = tab.length) == 0)
            tab = initTable();

        // 2. 桶为空，CAS 插入（无锁！）
        else if ((f = tabAt(tab, i = (n - 1) & hash)) == null) {
            if (casTabAt(tab, i, null, new Node<K,V>(hash, key, value, null)))
                break;  // CAS 成功，无需重试
        }

        // 3. 正在扩容（hash == MOVED），帮助扩容
        else if ((fh = f.hash) == MOVED)
            tab = helpTransfer(tab, f);

        // 4. 桶不为空，synchronized 锁住头节点
        else {
            synchronized (f) {  // 只锁这一个桶！
                if (tabAt(tab, i) == f) {  // double-check
                    if (fh >= 0) {
                        // 链表插入...
                    } else if (f instanceof TreeBin) {
                        // 红黑树插入...
                    }
                }
            }
        }
    }
    // 5. 增加计数（可能触发扩容）
    addCount(1L, binCount);
    return null;
}
```

**关键设计**：
- **空桶用 CAS**：不需要加锁，性能极高
- **非空桶用 synchronized 锁头节点**：锁粒度精确到单个桶
- **扩容时多线程协作**：检测到 MOVED 标记时，当前线程会"帮助扩容"

**size() 的实现**：

ConcurrentHashMap 使用类似 LongAdder 的分段计数策略：

```java
// 无竞争时直接操作 baseCount
private transient volatile long baseCount;

// 有竞争时使用 CounterCell 数组分段计数
@sun.misc.Contended static final class CounterCell {
    volatile long value;
}
private transient volatile CounterCell[] counterCells;

public int size() {
    long n = sumCount();
    return ((n < 0L) ? 0 :
            (n > (long)Integer.MAX_VALUE) ? Integer.MAX_VALUE :
            (int)n);
}

final long sumCount() {
    CounterCell[] as = counterCells; CounterCell a;
    long sum = baseCount;
    if (as != null) {
        for (int i = 0; i < as.length; ++i) {
            if ((a = as[i]) != null)
                sum += a.value;  // 累加所有分段
        }
    }
    return sum;
}
```

### 5.3 JDK 8 vs JDK 7 性能对比

| 维度 | JDK 7 分段锁 | JDK 8 CAS + synchronized |
|------|-------------|-------------------------|
| 锁粒度 | Segment 级别（16 个锁） | 单个桶级别（数组长度个锁） |
| 最大并发度 | 固定 16 | 理论无上限 |
| 内存开销 | 每个 Segment 预分配数组 | 按需分配 |
| 空桶操作 | 需要获取锁 | CAS 无锁 |
| 扩容 | 单线程 | 多线程协作 |

JDK 8 的方案在高并发场景下性能更优，因为绝大多数 put 操作要么命中空桶（CAS 无锁），要么只锁住一个桶。而 JDK 7 即使操作不同桶，只要落在同一 Segment 就会串行化。

---

## 六、TreeMap 与红黑树

### 6.1 红黑树的五条性质

红黑树是一种自平衡二叉搜索树，满足以下性质：

```
1. 每个节点是红色或黑色
2. 根节点是黑色
3. 叶子节点（NIL）是黑色
4. 红色节点的两个子节点都是黑色（不能有两个连续红节点）
5. 从任意节点到其所有叶子节点的路径上，黑色节点数目相同

        8(B)
       /    \
    4(R)    12(B)
   /   \    /    \
 2(B) 6(B) 10(R) 14(B)
```

性质 5 保证了最长路径不超过最短路径的 2 倍，从而保证查找、插入、删除的时间复杂度均为 O(log n)。

### 6.2 TreeMap 的插入与删除

TreeMap 基于红黑树实现，保证键有序：

```java
public class TreeMap<K,V> extends AbstractMap<K,V>
    implements NavigableMap<K,V>, Cloneable, Serializable {

    private transient Entry<K,V> root;
    private final Comparator<? super K> comparator;

    public V put(K key, V value) {
        Entry<K,V> t = root;
        if (t == null) {
            root = new Entry<>(key, value, null);
            size = 1;
            modCount++;
            return null;
        }
        // 二叉搜索树查找
        int cmp;
        Entry<K,V> parent;
        Comparator<? super K> cpr = comparator;
        if (cpr != null) {
            do {
                parent = t;
                cmp = cpr.compare(key, t.key);
                if (cmp < 0) t = t.left;
                else if (cmp > 0) t = t.right;
                else return t.setValue(value);
            } while (t != null);
        }
        // ... 找到插入位置后，执行红黑树的 fixAfterInsertion
        fixAfterInsertion(e);
        return null;
    }
}
```

插入后的 `fixAfterInsertion()` 方法通过旋转和变色恢复红黑树性质。删除操作类似，通过 `fixAfterDeletion()` 恢复平衡。

### 6.3 LinkedHashMap：有序 HashMap

LinkedHashMap 继承 HashMap，通过维护一条双向链表保证迭代顺序：

```java
public class LinkedHashMap<K,V> extends HashMap<K,V> {
    // 双向链表头尾
    transient LinkedHashMap.Entry<K,V> head;
    transient LinkedHashMap.Entry<K,V> tail;

    // 是否按访问顺序排序（true = LRU 模式）
    final boolean accessOrder;

    static class Entry<K,V> extends HashMap.Node<K,V> {
        Entry<K,V> before, after;  // 链表指针
        Entry(int hash, K key, V value, Node<K,V> next) {
            super(hash, key, value, next);
        }
    }
}
```

**两种排序模式**：

```java
// 1. 插入顺序（默认）：按 put 的先后顺序
Map<String, Integer> map = new LinkedHashMap<>();
map.put("a", 1); map.put("b", 2); map.put("c", 3);
// 迭代顺序：a, b, c

// 2. 访问顺序：每次 get/put 都把节点移到链表尾部
Map<String, Integer> lru = new LinkedHashMap<>(16, 0.75f, true);
lru.put("a", 1); lru.put("b", 2); lru.put("c", 3);
lru.get("a");  // a 移到尾部
// 迭代顺序：b, c, a
```

**用 LinkedHashMap 实现 LRU 缓存**：

```java
public class LRUCache<K, V> extends LinkedHashMap<K, V> {
    private final int maxSize;

    public LRUCache(int maxSize) {
        super(maxSize, 0.75f, true);  // accessOrder = true
        this.maxSize = maxSize;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        // 当大小超过容量时，移除最久未访问的元素（链表头部）
        return size() > maxSize;
    }
}

// 使用
LRUCache<String, String> cache = new LRUCache<>(3);
cache.put("a", "A");
cache.put("b", "B");
cache.put("c", "C");
cache.get("a");      // a 变成最近访问
cache.put("d", "D"); // 触发淘汰，b 被移除（最久未访问）
// 当前缓存：a, c, d
```

---

## 七、HashSet 与 TreeSet

### 7.1 HashSet 底层就是 HashMap

```java
public class HashSet<E> extends AbstractSet<E>
    implements Set<E>, Cloneable, Serializable {

    private transient HashMap<E,Object> map;

    // 一个虚拟的占位值，所有键共享
    private static final Object PRESENT = new Object();

    public HashSet() {
        map = new HashMap<>();
    }

    public boolean add(E e) {
        return map.put(e, PRESENT) == null;  // 键存入 HashMap，值为 PRESENT
    }

    public boolean contains(Object o) {
        return map.containsKey(o);
    }

    public boolean remove(Object o) {
        return map.remove(o) == PRESENT;
    }
}
```

HashSet 的所有操作都委托给内部的 HashMap，元素作为键存储，值统一为一个 `PRESENT` 常量对象。因此 HashSet 的性能特性与 HashMap 完全一致：O(1) 的增删查，无序，允许 null。

### 7.2 TreeSet 底层就是 TreeMap

```java
public class TreeSet<E> extends AbstractSet<E>
    implements NavigableSet<E>, Cloneable, Serializable {

    private transient NavigableMap<E,Object> m;
    private static final Object PRESENT = new Object();

    public TreeSet() {
        this(new TreeMap<>());  // 底层使用 TreeMap
    }

    public boolean add(E e) {
        return m.put(e, PRESENT) == null;
    }
}
```

TreeSet 保证元素有序（自然排序或自定义 Comparator），增删查的时间复杂度为 O(log n)。

### 7.3 equals 和 hashCode 的契约

使用 HashSet（或 HashMap 的键）时，必须遵守以下契约：

1. **如果两个对象 `equals()` 返回 true，它们的 `hashCode()` 必须相同。**
2. **如果两个对象 `hashCode()` 相同，`equals()` 不一定返回 true（哈希冲突）。**
3. **在对象作为 HashMap 的键期间，其 `hashCode()` 不能改变。**

```java
// 反面教材：可变对象作为 HashMap 的键
class Point {
    int x, y;
    // 假设 hashCode 基于 x, y 计算
}

Map<Point, String> map = new HashMap<>();
Point p = new Point(1, 2);
map.put(p, "origin");
p.x = 100;  // 修改了参与 hashCode 计算的字段！
map.get(p); // 返回 null！因为 p 的 hash 变了，定位到了不同的桶
```

**最佳实践**：HashMap 的键应该是不可变对象（如 String、Integer），或至少保证 `hashCode()` 依赖的字段在放入 Map 后不会改变。

---

## 八、PriorityQueue 与堆

### 8.1 二叉堆原理

二叉堆是一棵完全二叉树，分为最大堆和最小堆。PriorityQueue 默认是最小堆：

```
最小堆（数组表示）：[1, 3, 2, 7, 5, 4, 6]

        1
       / \
      3   2
     / \ / \
    7  5 4  6

性质：每个节点 <= 其子节点（最小堆）
数组中：节点 i 的左子 = 2i+1，右子 = 2i+2，父 = (i-1)/2
```

### 8.2 PriorityQueue 源码

```java
public class PriorityQueue<E> extends AbstractQueue<E> implements Serializable {

    transient Object[] queue;  // 堆数组
    private int size;
    private final Comparator<? super E> comparator;

    public PriorityQueue() {
        this(DEFAULT_INITIAL_CAPACITY, null);  // 默认最小堆
    }

    public boolean offer(E e) {
        if (e == null) throw new NullPointerException();
        modCount++;
        int i = size;
        if (i >= queue.length) grow(i + 1);
        size = i + 1;
        if (i == 0)
            queue[0] = e;
        else
            siftUp(i, e);  // 上浮
        return true;
    }

    // 上浮：新元素从底部向上找位置
    private void siftUp(int k, E x) {
        if (comparator != null)
            siftUpUsingComparator(k, x);
        else
            siftUpComparable(k, x);
    }

    private void siftUpComparable(int k, E x) {
        Comparable<? super E> key = (Comparable<? super E>) x;
        while (k > 0) {
            int parent = (k - 1) >>> 1;  // 父节点索引
            Object e = queue[parent];
            if (key.compareTo((E) e) >= 0)  // 比父节点大，停止
                break;
            queue[k] = e;  // 父节点下沉
            k = parent;
        }
        queue[k] = key;
    }

    // 下沉：删除堆顶后，最后一个元素从顶部向下找位置
    private void siftDownComparable(int k, E x) {
        Comparable<? super E> key = (Comparable<? super E>)x;
        int half = size >>> 1;  // 非叶子节点范围
        while (k < half) {
            int child = (k << 1) + 1;  // 左子节点
            Object c = queue[child];
            int right = child + 1;
            if (right < size &&
                ((Comparable<? super E>) c).compareTo((E) queue[right]) > 0)
                c = queue[child = right];  // 取较小的子节点
            if (key.compareTo((E) c) <= 0)  // 比子节点小，停止
                break;
            queue[k] = c;
            k = child;
        }
        queue[k] = key;
    }
}
```

**siftUp 过程示意**（插入元素 2）：

```
插入前: [1, 3, 5, 7, 9, 8]
        1
       / \
      3   5
     / \ /
    7  9 8

插入 2 到末尾: [1, 3, 5, 7, 9, 8, 2]
        1
       / \
      3   5
     / \ / \
    7  9 8  2    ← 2 < 5，上浮

交换 2 和 5:   [1, 3, 2, 7, 9, 8, 5]
        1
       / \
      3   2
     / \ / \
    7  9 8  5    ← 2 > 1，停止
```

### 8.3 TopK 问题的堆解法

"从 N 个数中找出最大的 K 个数"是经典的面试问题，最优解法是使用最小堆：

```java
// 维护一个大小为 K 的最小堆
public static int[] topK(int[] nums, int k) {
    PriorityQueue<Integer> minHeap = new PriorityQueue<>(k);

    for (int num : nums) {
        if (minHeap.size() < k) {
            minHeap.offer(num);
        } else if (num > minHeap.peek()) {
            minHeap.poll();    // 移除堆顶（当前最小值）
            minHeap.offer(num); // 加入新元素
        }
    }

    int[] result = new int[k];
    for (int i = 0; i < k; i++) {
        result[i] = minHeap.poll();
    }
    return result;
}
```

**为什么用最小堆？** 堆顶始终是堆中最小值。当堆大小为 K 时，堆顶就是"当前 TopK 中的最小值"。如果新元素大于堆顶，说明它应该进入 TopK，替换掉当前的最小值。

**时间复杂度**：O(N log K)。每个元素最多执行一次 offer 和一次 poll，每次 O(log K)。相比排序后取前 K 的 O(N log N)，在 N 远大于 K 时优势明显。

```
N = 1,000,000, K = 10 时：
排序法: 1,000,000 × log(1,000,000) ≈ 20,000,000 次比较
堆方法: 1,000,000 × log(10) ≈ 3,300,000 次比较
```

---

## 九、集合框架面试题精选

### 题目 1：HashMap 为什么线程不安全？

**答**：HashMap 的 `put()` 不是原子操作。在"检查桶是否为空"和"写入节点"之间，其他线程可能已经修改了该桶。典型问题包括：
1. **数据覆盖**：两个线程同时写入同一个桶，后写入的覆盖先写入的。
2. **size 不准确**：`++size` 不是原子操作（读-改-写），并发下会丢失计数。
3. **JDK 7 的死循环**：头插法在并发扩容时可能形成环形链表（JDK 8 已修复）。

### 题目 2：ConcurrentHashMap 怎么保证线程安全？

**答**：JDK 8 采用三种策略：
1. **空桶用 CAS**：`casTabAt()` 原子性地写入新节点，无锁操作。
2. **非空桶用 synchronized**：只锁住当前桶的头节点，其他桶的操作不受影响。
3. **volatile 变量**：`table` 和 `Node.value` 用 volatile 修饰，保证可见性。
4. **扩容协作**：检测到 MOVED 标记时，线程会"帮助扩容"，加速扩容过程。

### 题目 3：ArrayList 扩容的具体过程？

**答**：
1. 调用 `add()` 时先检查容量。
2. 如果当前 `elementData` 是默认空数组，首次扩容到 10。
3. 否则，`grow()` 方法将容量扩大为原来的 1.5 倍（`oldCapacity + (oldCapacity >> 1)`）。
4. 通过 `Arrays.copyOf()` 创建新数组并复制数据，时间复杂度 O(n)。
5. 如果扩容后超过 `MAX_ARRAY_SIZE`（Integer.MAX_VALUE - 8），会尝试分配 Integer.MAX_VALUE 大小。

### 题目 4：fail-fast 的原理是什么？

**答**：ArrayList、HashMap 等内部维护 `modCount` 计数器，每次结构性修改（add/remove/clear）时递增。迭代器创建时记录 `expectedModCount = modCount`。在迭代过程中，如果发现 `modCount != expectedModCount`，说明集合被外部修改，立即抛出 `ConcurrentModificationException`。注意这只是一个尽力而为的检测，不是 100% 可靠——如果修改发生在创建迭代器之前，或修改后恰好 `modCount` 回绕到 `expectedModCount`，就不会检测到。

### 题目 5：HashMap 的 hash 方法为什么要做扰动？

**答**：HashMap 用 `(n-1) & hash` 计算桶索引，当 n 较小时只有 hash 值的低位参与运算。如果 hashCode 的低位分布不均匀（如 Integer 的 hashCode 等于值本身），会导致大量冲突。扰动函数 `hash ^ (hash >>> 16)` 将高位信息混入低位，提高低位的随机性，减少冲突概率。

### 题目 6：HashMap 为什么用红黑树而不是 AVL 树？

**答**：红黑树的插入/删除操作最多需要 2 次旋转（AVL 树可能需要 O(log n) 次旋转）。HashMap 中树化本身就是极端情况的保底策略，操作频率很低。红黑树在插入/删除时的常数因子更小，代码实现也相对简洁（JDK 中 AVL 树的参考实现更复杂）。综合来看，红黑树是更务实的选择。

### 题目 7：LinkedHashMap 如何实现 LRU 缓存？

**答**：LinkedHashMap 构造方法传入 `accessOrder=true`，每次 `get()` 或 `put()` 都会把访问的节点移到链表尾部。重写 `removeEldestEntry()` 方法，当 `size() > maxSize` 时返回 true，框架会自动移除链表头部（最久未访问的）元素。

### 题目 8：HashSet 如何保证元素不重复？

**答**：HashSet 内部使用 HashMap 存储，元素作为 HashMap 的键。当 `add(e)` 时，调用 `map.put(e, PRESENT)`。如果元素已存在（`equals()` 和 `hashCode()` 匹配），`put()` 会覆盖旧值并返回旧值，`add()` 检测到返回值不为 null，返回 false。

### 题目 9：PriorityQueue 的 poll() 时间复杂度是多少？

**答**：O(log n)。poll() 移除堆顶后，将最后一个元素放到堆顶，然后执行 siftDown 操作。siftDown 从根节点向下比较并交换，最多走完全二叉树的高度 log n 层。

### 题目 10：HashMap 的初始容量设为多少合适？

**答**：如果预先知道元素数量 N，建议设置为 `N / 0.75 + 1`（向上取整为 2 的幂）。因为当元素数量超过 `capacity * loadFactor` 时就会触发扩容。例如预计存入 1000 个元素，初始容量应为 `1000 / 0.75 + 1 ≈ 1335`，向上取整为 2048。这样可以避免中途扩容，提升性能。Guava 库的 `Maps.newHashMapWithExpectedSize()` 方法就是这个逻辑。

---

## 总结

Java 集合框架的设计体现了诸多工程智慧：

1. **接口与实现分离**：Collection、Map 定义统一协议，ArrayList、HashMap 等提供具体实现，用户面向接口编程。
2. **按需选择数据结构**：ArrayList 用数组实现 O(1) 随机访问，LinkedList 用链表优化头尾操作，HashMap 用哈希表实现 O(1) 查找，TreeMap 用红黑树保证有序。
3. **性能保底策略**：HashMap 在极端哈希冲突时树化，ConcurrentHashMap 用 CAS 减少锁竞争，ArrayList 的 1.5 倍扩容平衡时间空间。
4. **并发安全分层**：单线程用 HashMap/ArrayList，多线程用 ConcurrentHashMap/CopyOnWriteArrayList，各有适用场景。

掌握这些核心实现，不仅能让我们在面试中游刃有余，更重要的是能在日常开发中做出更合理的技术选型。集合框架的源码值得反复阅读——每一次深入，都会有新的收获。

## 附录：实际开发中的选型建议

在日常开发中，面对不同的业务场景，选择合适的集合类型至关重要。以下是根据多年实践经验总结的选型指南：

**场景一：简单的元素存储与遍历**。大多数情况下，ArrayList 是默认选择。它的内存布局连续，对 CPU 缓存友好，在绝大多数场景下的性能表现都优于 LinkedList。除非你有大量头尾插入或删除的需求，否则不需要考虑 LinkedList。

**场景二：需要快速查找的映射关系**。HashMap 是不二之选。它提供了接近常数时间的查找性能。如果需要键有序，使用 TreeMap；如果需要保持插入顺序，使用 LinkedHashMap。注意 HashMap 的负载因子默认 0.75，这是时间和空间之间的折中——更高的负载因子节省空间但增加查找成本。

**场景三：需要去重的元素集合**。HashSet 提供了基于哈希的快速去重能力，平均时间复杂度为 O(1)。如果还需要元素有序，TreeSet 基于红黑树实现，保证元素按自然顺序或自定义比较器排序，但时间复杂度为 O(log n)。

**场景四：多线程环境下的并发访问**。优先考虑 ConcurrentHashMap 而非 Hashtable 或 Collections.synchronizedMap()。ConcurrentHashMap 的细粒度锁设计使其在高并发场景下拥有显著的性能优势。如果读操作远多于写操作，CopyOnWriteArrayList 是更好的选择，它通过写时复制策略实现无锁读取。

**场景五：需要按优先级处理任务**。PriorityQueue 基于二叉堆实现，适合实现任务调度器、事件处理系统等需要按优先级排序的场景。注意 PriorityQueue 不是线程安全的，多线程环境请使用 PriorityBlockingQueue。

**场景六：实现缓存机制**。LinkedHashMap 配合 accessOrder 参数和 removeEldestEntry 方法，可以用极少的代码实现一个功能完整的 LRU 缓存。对于生产环境中的高并发缓存，推荐使用 Guava Cache 或 Caffeine，它们在 LinkedHashMap 的基础上增加了过期淘汰、缓存统计、异步加载等高级特性。

选择集合类型时，务必考虑三个核心因素：**数据规模**、**操作频率分布**（读多写少还是写多读少）和**线程安全性要求**。正确的选型能带来数量级的性能提升，而错误的选型则可能在系统规模增长后成为性能瓶颈。建议在新项目中引入集合使用时做一次简单的性能基准测试，用数据验证选型是否合理。
