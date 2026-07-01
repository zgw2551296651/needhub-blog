# RocketMQ 原理与实战——架构设计、消息可靠性与消费模式

## 引言

在分布式系统中，消息队列是实现系统解耦、削峰填谷、异步通信的核心基础设施。Apache RocketMQ 作为阿里巴巴开源的分布式消息中间件，经过双十一海量流量的洗礼，已经成长为金融级消息可靠传输的标杆产品。相比于 Kafka 偏向日志流处理、RabbitMQ 偏向轻量级消息路由，RocketMQ 在消息可靠性、事务消息、延迟消息等企业级特性上有着更为出色的表现。

本文将从架构设计、消息可靠性机制、消费模式、顺序消息、事务消息等多个维度，深入剖析 RocketMQ 的核心原理，并结合实战代码和面试题，帮助你全面掌握这一核心中间件。

---

## 一、RocketMQ 整体架构与四大角色

### 1.1 架构总览

RocketMQ 的架构由四大核心角色组成，它们各司其职，共同构建了一个高可用、高可靠的消息传输系统：

```
                    +------------------+
                    |   NameServer     |
                    |  (路由发现中心)    |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
    +---------v---------+        +---------v---------+
    |     Broker        |        |     Broker        |
    |   (消息存储)       |        |   (消息存储)       |
    |  Master + Slave   |        |  Master + Slave   |
    +---------+---------+        +---------+---------+
              ^                             ^
              |                             |
    +---------+---------+        +---------+---------+
    |    Producer       |        |    Consumer        |
    |   (消息生产者)     |        |   (消息消费者)      |
    +-------------------+        +-------------------+
```

### 1.2 四大角色详解

**1. Producer（消息生产者）**

Producer 负责产生消息并发送到 Broker。RocketMQ 的 Producer 支持三种发送方式：

```java
// 1. 同步发送 —— 阻塞等待 Broker 确认，可靠性最高
SendResult result = producer.send(new Message("OrderTopic", "create", orderId.getBytes()));
System.out.println("发送状态: " + result.getSendStatus());

// 2. 异步发送 —— 通过回调函数接收结果，不阻塞主线程
producer.send(new Message("OrderTopic", "create", orderId.getBytes()),
    new SendCallback() {
        @Override
        public void onSuccess(SendResult sendResult) {
            System.out.println("异步发送成功: " + sendResult.getMsgId());
        }
        @Override
        public void onException(Throwable e) {
            System.err.println("异步发送失败: " + e.getMessage());
            // 降级处理：写入本地数据库，后续补偿
        }
    });

// 3. Oneway 发送 —— 发后即忘，不等待任何确认
producer.sendOneway(new Message("LogTopic", "access", logData.getBytes()));
```

**2. NameServer（路由发现中心）**

NameServer 是 RocketMQ 的轻量级注册中心，负责管理 Broker 的路由信息。与 ZooKeeper 相比，NameServer 的设计极为简洁——各个 NameServer 节点之间互不通信，每个节点都保存完整的集群路由信息。

```
Producer/Consumer 获取路由信息的流程：

1. Broker 启动时向所有 NameServer 注册自身信息
2. Broker 每 30s 向 NameServer 发送心跳包
3. NameServer 每 10s 扫描一次，剔除超过 120s 未发送心跳的 Broker
4. Producer/Consumer 每 30s 从 NameServer 拉取最新路由表
```

**3. Broker（消息存储服务器）**

Broker 是 RocketMQ 的核心组件，负责消息的存储、转发和查询。一个 Broker 集群通常采用 Master-Slave 架构：

- **Master**：负责消息的写入和读取
- **Slave**：从 Master 同步消息，提供读取冗余

**4. Consumer（消息消费者）**

Consumer 从 Broker 拉取消息并进行消费。RocketMQ 支持 Push 和 Pull 两种消费模式，后文将详细展开。

---

## 二、Topic 与 MessageQueue：逻辑分区与物理分区

### 2.1 Topic 的逻辑概念

Topic 是 RocketMQ 中消息的一级分类，是消息发布的逻辑单元。例如，订单系统可能有 `ORDER_CREATE_TOPIC`、`ORDER_PAY_TOPIC` 等。

### 2.2 MessageQueue 的物理分区

每个 Topic 下会被划分为多个 MessageQueue（消息队列），这是 RocketMQ 实现并行发送和消费的关键：

```
Topic: ORDER_CREATE_TOPIC
├── MessageQueue-0  →  Broker-A
├── MessageQueue-1  →  Broker-A
├── MessageQueue-2  →  Broker-B
├── MessageQueue-3  →  Broker-B
├── MessageQueue-4  →  Broker-C
├── MessageQueue-5  →  Broker-C
├── MessageQueue-6  →  Broker-D
└── MessageQueue-7  →  Broker-D

每个 MessageQueue 内部消息按顺序存储，通过 offset 标识位置
```

**关键设计**：一个 MessageQueue 只允许一个 Consumer 消费（集群模式下），但一个 Consumer 可以消费多个 MessageQueue。这种设计保证了分区内的消息顺序性，同时通过多分区实现了水平扩展。

### 2.3 自定义分区策略

```java
// 通过 MessageQueueSelector 控制消息发送到哪个队列
producer.send(message, new MessageQueueSelector() {
    @Override
    public MessageQueue select(List<MessageQueue> mqs, Message msg, Object arg) {
        // arg 为 orderId，相同 orderId 的消息进入同一队列
        Long orderId = (Long) arg;
        int index = (int)(orderId % mqs.size());
        return mqs.get(index);
    }
}, orderId);
```

---

## 三、消息可靠性：三道防线

消息可靠性是消息队列的生命线。RocketMQ 从生产端、存储端、消费端三个维度构建了完整的可靠性保障体系。

### 3.1 生产端可靠性：三种发送模式对比

| 发送方式 | 可靠性 | 延迟 | 适用场景 |
|---------|--------|------|---------|
| 同步发送 | 最高（阻塞等待 ACK） | 高 | 核心交易链路 |
| 异步发送 | 较高（回调处理） | 中 | 日志采集、非核心通知 |
| Oneway | 无保障 | 极低 | 可丢失的监控数据 |

**消息丢失场景分析——Oneway 的隐患**：

Oneway 模式下，Producer 将消息发送到 Broker 后立即返回，不等待任何确认。如果此时网络抖动、Broker 繁忙或 Broker 宕机，消息将静默丢失，且没有任何错误回调。因此，Oneway 仅适用于对消息丢失完全不敏感的场景。

### 3.2 存储端可靠性：刷盘与复制策略

RocketMQ 在 Broker 端提供了两个维度的可靠性保障：刷盘策略和复制策略。

```
消息写入流程：

Producer → Broker Master
              |
              ├── 写入 MappedFile（内存映射文件）
              |
              ├── 刷盘策略
              |    ├── 同步刷盘 (SYNC_FLUSH)：调用 force()，确保数据写入磁盘
              |    |    └── 优点：断电不丢消息
              |    |    └── 缺点：延迟增加约 1-5ms
              |    |
              |    └── 异步刷盘 (ASYNC_FLUSH)：先写入 PageCache，后台线程刷盘
              |         └── 优点：低延迟
              |         └── 缺点：断电可能丢失少量消息
              |
              └── 复制策略
                   ├── 同步复制 (SYNC_MASTER)：等待 Slave ACK
                   |    └── 优点：Master 宕机可切换 Slave
                   |    └── 缺点：延迟增加
                   |
                   └── 异步复制 (ASYNC_MASTER)：Master 写入后立即返回
                        └── 优点：低延迟
                        └── 缺点：Master 磁盘故障时消息可能丢失
```

**刷盘策略配置**：

```properties
# broker.conf
# 同步刷盘：消息写入磁盘后才返回 ACK
flushDiskType=SYNC_FLUSH

# 异步刷盘：消息写入 PageCache 后立即返回（默认）
flushDiskType=ASYNC_FLUSH
```

**复制策略配置**：

```properties
# 同步复制：Master 等待 Slave 确认后返回
brokerRole=SYNC_MASTER

# 异步复制：Master 写入后立即返回（默认）
brokerRole=ASYNC_MASTER
```

### 3.3 金融级可靠性方案：同步刷盘 + 同步复制

在金融、支付等对消息丢失零容忍的场景中，推荐采用 **同步刷盘 + 同步复制** 的组合：

```
金融级消息传输流程（最严格配置）：

1. Producer 同步发送消息到 Master
2. Master 将消息写入 MappedFile
3. Master 调用 force() 同步刷盘 → 确保消息落盘
4. Master 将消息同步复制到 Slave
5. Slave 调用 force() 同步刷盘 → Slave 也落盘
6. Slave 返回 ACK 给 Master
7. Master 返回 ACK 给 Producer

结论：只有 Master 和 Slave 都完成磁盘写入，Producer 才认为发送成功
代价：单条消息延迟约 5-15ms，吞吐量下降约 30-50%
```

### 3.4 消费端可靠性：消费确认机制

```java
// 消费端必须显式返回消费状态
consumer.registerMessageListener(new MessageListenerConcurrently() {
    @Override
    public ConsumeConcurrentlyStatus consumeMessage(
            List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
        try {
            // 执行业务逻辑
            processOrder(msgs);
            // 成功：返回 SUCCESS，Broker 标记消息为已消费
            return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
        } catch (Exception e) {
            // 失败：返回 RECONSUME_LATER，Broker 会重新投递
            // 默认重试 16 次，间隔递增：10s, 30s, 1m, 2m...
            return ConsumeConcurrentlyStatus.RECONSUME_LATER;
        }
    }
});
```

**消息丢失场景——消费者吞异常**：

这是一个非常隐蔽的消息丢失场景。如果消费者的 catch 块捕获了异常但忘记返回 `RECONSUME_LATER`，或者 catch 块直接返回了 `CONSUME_SUCCESS`，Broker 会认为消息已被成功处理，从而将其标记为已消费。这条消息就此"消失"了。

### 3.5 消息保留期

RocketMQ 默认消息保留时间为 72 小时（3 天），超时后消息将被自动删除。如果消费者因为故障宕机超过 72 小时，恢复后将无法消费之前的消息。可通过 `fileReservedTime` 参数调整：

```properties
# 消息保留时间，单位：小时
fileReservedTime=168  # 保留 7 天
```

---

## 四、消费模式深度解析

### 4.1 Push 消费模式（长轮询）

Push 模式是 RocketMQ 最常用的消费模式。虽然名为"Push"，但其底层实现实际上是 **长轮询（Long Polling）**：

```
Push 模式工作原理：

Consumer                          Broker
   |                                |
   |--- PullRequest(拉取消息) ------->|
   |                                |-- 有新消息？立即返回
   |                                |-- 无新消息？挂起请求（默认 30s）
   |                                |-- 30s 内有新消息到达 → 立即返回
   |                                |-- 30s 内无新消息 → 返回空结果
   |<-- 返回消息或空结果 -------------|
   |                                |
   |--- 提交新的 PullRequest ------->|  (循环)
```

```java
// Push 消费者配置
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer("order_consumer_group");
consumer.setNamesrvAddr("namesrv1:9876;namesrv2:9876");

// 设置消费线程池大小
consumer.setConsumeThreadMin(20);
consumer.setConsumeThreadMax(64);

// 订阅 Topic
consumer.subscribe("ORDER_TOPIC", "*");

// 注册消息监听器
consumer.registerMessageListener(new MessageListenerConcurrently() {
    @Override
    public ConsumeConcurrentlyStatus consumeMessage(
            List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
        for (MessageExt msg : msgs) {
            System.out.println("消费消息: " + new String(msg.getBody()));
        }
        return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
    }
});

consumer.start();
```

### 4.2 Pull 消费模式（手动拉取）

Pull 模式给予开发者更大的控制权，可以精确控制拉取频率、批量大小和消费进度：

```java
// RocketMQ 5.0 推荐使用 DefaultLitePullConsumer
DefaultLitePullConsumer pullConsumer = new DefaultLitePullConsumer("pull_consumer_group");
pullConsumer.setNamesrvAddr("namesrv1:9876");

// 订阅
pullConsumer.subscribe("ORDER_TOPIC", "*");
pullConsumer.start();

// 手动控制拉取
while (true) {
    // 每次最多拉取 100 条消息，超时 1000ms
    List<MessageExt> messages = pullConsumer.poll(1000);
    if (!messages.isEmpty()) {
        // 批量处理
        batchProcess(messages);
        // 手动提交消费进度
        pullConsumer.commitSync();
    }
}
```

### 4.3 POP 消费模式（5.0+ 服务端负载均衡）

POP 模式是 RocketMQ 5.0 引入的全新消费模式，它解决了 Push 模式在消费者扩缩容时的 Rebalance 问题：

```
Push 模式 vs POP 模式对比：

Push 模式：
- 客户端 Rebalance，消费者变化触发队列重新分配
- 扩缩容时有短暂消费暂停
- 消费者数量不能超过 MessageQueue 数量

POP 模式：
- 服务端负载均衡，Broker 决定分发消息
- 消费者可无限水平扩展
- 无需 Rebalance，扩缩容无感知
- 基于消息粒度的 ACK，更加精确
```

### 4.4 集群模式 vs 广播模式

```java
// 集群模式（默认）：每条消息只被一个消费者消费
consumer.setMessageModel(MessageModel.CLUSTERING);

// 广播模式：每条消息被所有消费者消费（完整副本）
consumer.setMessageModel(MessageModel.BROADCASTING);
```

```
集群模式 (CLUSTERING)：
MessageQueue-0: msg1, msg2, msg3 → Consumer-A 消费全部
MessageQueue-1: msg4, msg5, msg6 → Consumer-B 消费全部

广播模式 (BROADCASTING)：
MessageQueue-0: msg1, msg2, msg3 → Consumer-A 消费全部
                                  → Consumer-B 消费全部
                                  → Consumer-C 消费全部
```

**注意**：广播模式下不支持消费失败重试，因为 Broker 不维护广播模式的消费进度。

---

## 五、顺序消息

### 5.1 全局顺序 vs 分区顺序

**全局顺序**：Topic 下所有消息严格按照发送顺序消费。实现方式是将 Topic 只配置一个 MessageQueue，所有消息进入同一队列。这种方式严重限制了吞吐量，仅适用于极端场景。

**分区顺序**：相同业务 ID 的消息保证顺序，不同业务 ID 之间不保证顺序。这是更实用的方案。

```java
// 分区顺序消息示例
// 相同 orderId 的消息保证顺序：创建 → 支付 → 发货
producer.send(createMsg, (mqs, msg, arg) -> {
    Long orderId = (Long) arg;
    return mqs.get((int)(orderId % mqs.size()));
}, orderId);

producer.send(payMsg, (mqs, msg, arg) -> {
    Long orderId = (Long) arg;
    return mqs.get((int)(orderId % mqs.size()));
}, orderId);

// 消费端使用顺序监听器
consumer.registerMessageListener(new MessageListenerOrderly() {
    @Override
    public ConsumeOrderlyStatus consumeMessage(
            List<MessageExt> msgs, ConsumeOrderlyContext context) {
        // 顺序消费逻辑
        processInOrder(msgs);
        return ConsumeOrderlyStatus.SUCCESS;
    }
});
```

---

## 六、事务消息

RocketMQ 的事务消息是其最具特色的功能之一，用于解决分布式事务中的消息投递与本地事务一致性问题。

### 6.1 事务消息流程

```
事务消息完整流程：

Producer                         Broker                          Consumer
    |                               |                               |
    |--- 1. 发送 half 消息 --------->|                               |
    |<-- 2. half 消息发送成功 -------|                               |
    |                               |                               |
    |--- 3. 执行本地事务             |                               |
    |   (如：扣减库存)               |                               |
    |                               |                               |
    |--- 4a. 本地事务成功 ---------->|                               |
    |   (发送 COMMIT)               |--- 5. 投递消息 -------------->|
    |                               |                               |
    |--- 4b. 本地事务失败 ---------->|                               |
    |   (发送 ROLLBACK)             |--- 丢弃 half 消息              |
    |                               |                               |

特殊情况处理：
如果步骤 4 因为网络问题未到达 Broker，Broker 会启动事务回查机制：
    |--- 6. Broker 回查事务状态 ---->|
    |<-- 7. Producer 检查本地事务状态|
    |--- 8. 再次发送 COMMIT/ROLLBACK>|
```

### 6.2 事务消息代码实现

```java
// 事务消息生产者
TransactionMQProducer producer = new TransactionMQProducer("tx_producer_group");
producer.setNamesrvAddr("namesrv1:9876");

// 设置事务监听器
producer.setTransactionListener(new TransactionListener() {
    @Override
    public LocalTransactionState executeLocalTransaction(
            Message msg, Object arg) {
        try {
            // 执行本地事务
            String orderId = (String) arg;
            orderService.deductStock(orderId);
            // 本地事务成功，提交消息
            return LocalTransactionState.COMMIT_MESSAGE;
        } catch (Exception e) {
            // 本地事务失败，回滚消息
            return LocalTransactionState.ROLLBACK_MESSAGE;
        }
    }

    @Override
    public LocalTransactionState checkLocalTransaction(MessageExt msg) {
        // 事务回查：检查本地事务是否执行成功
        String orderId = msg.getKeys();
        boolean success = orderService.checkTransactionStatus(orderId);
        if (success) {
            return LocalTransactionState.COMMIT_MESSAGE;
        } else {
            return LocalTransactionState.UNKNOW; // 继续回查
        }
    }
});

producer.start();

// 发送事务消息
Message msg = new Message("ORDER_TOPIC", "create", orderId.getBytes());
producer.sendMessageInTransaction(msg, orderId);
```

---

## 七、延迟消息与定时消息

RocketMQ 支持延迟消息投递，常用于订单超时关闭、延迟重试等场景。

### 7.1 延迟等级

RocketMQ 默认支持 18 个延迟等级（开源版本不支持任意时间延迟）：

```
延迟等级: 1    2    3    4    5    6    7    8    9
延迟时间: 1s   5s   10s  30s  1m   2m   3m   4m   5m

延迟等级: 10   11   12   13   14   15   16   17   18
延迟时间: 6m   7m   8m   9m   10m  20m  30m  1h   2h
```

```java
// 设置延迟等级为 5（即延迟 1 分钟投递）
Message msg = new Message("ORDER_TIMEOUT_TOPIC", "close", orderId.getBytes());
msg.setDelayTimeLevel(5);
producer.send(msg);
```

### 7.2 应用场景：订单超时自动关闭

```java
// 订单创建成功后，发送一条延迟 30 分钟的消息
Message delayMsg = new Message("ORDER_TIMEOUT_TOPIC", orderId.getBytes());
delayMsg.setDelayTimeLevel(16); // 30 分钟
producer.send(delayMsg);

// 消费者在 30 分钟后收到消息，检查订单是否已支付
consumer.registerMessageListener((msgs, context) -> {
    String orderId = new String(msgs.get(0).getBody());
    Order order = orderService.getById(orderId);
    if (order.getStatus() == OrderStatus.UNPAID) {
        orderService.closeOrder(orderId); // 关闭未支付订单
        // 恢复库存
        stockService.restore(orderId);
    }
    return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
});
```

---

## 八、消息幂等性

在分布式环境下，消息可能被重复投递（网络抖动、消费者重启等），因此消费端必须保证幂等性。

### 8.1 唯一消息 ID + 去重表

```java
// 消费端幂等实现
public ConsumeConcurrentlyStatus consumeMessage(
        List<MessageExt> msgs, ConsumeConcurrentlyContext context) {
    for (MessageExt msg : msgs) {
        String msgId = msg.getMsgId(); // RocketMQ 全局唯一 ID

        // 方案一：数据库唯一索引去重
        try {
            messageConsumeLogDao.insert(
                new ConsumeLog(msgId, msg.getTopic(), new Date()));
        } catch (DuplicateKeyException e) {
            // 消息已消费过，跳过
            log.info("重复消息，跳过: {}", msgId);
            continue;
        }

        // 方案二：Redis SETNX 去重（适合高并发场景）
        Boolean isNew = redisTemplate.opsForValue()
            .setIfAbsent("mq:consumed:" + msgId, "1", 24, TimeUnit.HOURS);
        if (Boolean.FALSE.equals(isNew)) {
            continue; // 重复消息
        }

        // 执行业务逻辑
        processMessage(msg);
    }
    return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
}
```

### 8.2 业务层面的幂等

除了消息 ID 去重，更推荐在业务层面实现幂等：

```java
// 利用数据库唯一约束实现业务幂等
// 例如：订单支付时，使用订单号作为唯一键
public void payOrder(String orderId, BigDecimal amount) {
    // INSERT INTO payment_record (order_id, amount, status)
    // VALUES (?, ?, 'SUCCESS')
    // ON DUPLICATE KEY UPDATE status = 'SUCCESS'
    // 如果 order_id 有唯一约束，重复插入会失败，从而实现幂等
    paymentDao.insertIgnore(new PaymentRecord(orderId, amount));
}
```

---

## 九、消息丢失场景总结

全面梳理 RocketMQ 中可能导致消息丢失的场景：

| 场景 | 原因 | 解决方案 |
|------|------|---------|
| Oneway 发送 | 无 ACK 机制，发送失败无感知 | 核心业务使用同步发送 |
| 异步刷盘 + 断电 | PageCache 中的数据未刷入磁盘 | 使用同步刷盘 |
| 异步复制 + 磁盘故障 | Master 宕机，Slave 数据不完整 | 使用同步复制 |
| 消费者吞异常 | catch 后返回 SUCCESS | 严格处理异常，失败返回 RECONSUME_LATER |
| 消息超过 72h 保留期 | 消费者长时间未消费 | 增大 fileReservedTime 参数 |
| Rebalance 期间消费暂停 | 消费者扩缩容 | 使用 POP 消费模式 |

---

## 十、RocketMQ 存储架构深度剖析

### 10.1 CommitLog 与 ConsumeQueue

RocketMQ 采用 **所有 Topic 共用一个 CommitLog** 的存储设计，这与 Kafka 每个 Partition 一个文件的方案有本质区别：

```
RocketMQ 存储架构：

                    CommitLog（顺序写入，所有Topic共用）
                    ┌──────────────────────────────────────┐
                    │ TopicA-Q0 │ TopicB-Q1 │ TopicA-Q2 │ ...│
                    └──────────────────────────────────────┘
                              │
                    ┌─────────┼─────────┐
                    │         │         │
              ┌─────v───┐ ┌──v──────┐ ┌v────────┐
              │TopicA    │ │TopicB   │ │TopicC   │
              │ConsumeQ  │ │ConsumeQ │ │ConsumeQ │
              └─────────┘ └─────────┘ └─────────┘
                    │
                    v
              IndexFile（消息索引，支持按 Key 或时间查询）
```

**CommitLog**：所有消息按写入顺序追加到一个文件中，单个文件默认 1GB，写满后创建新文件。文件名为起始偏移量（20位数字）。顺序写入使得磁盘 IO 效率极高，配合 MappedFile（内存映射文件）技术，单台 Broker 的写入吞吐量可以达到十万级 TPS。

**ConsumeQueue**：每个 MessageQueue 对应一个 ConsumeQueue 文件，存储该队列中每条消息在 CommitLog 中的偏移量和大小。Consumer 消费时先查 ConsumeQueue 获取偏移量，再从 CommitLog 中读取完整消息。ConsumeQueue 中每条记录固定 20 字节（8字节偏移 + 4字节大小 + 8字节Tag哈希），这种定长设计使得查找效率极高。

**IndexFile**：提供按消息 Key 和时间范围查询消息的能力。底层采用类似 JDK HashMap 的结构：Header + SlotTable + IndexLinked。一个 IndexFile 最多存储 2000 万条索引记录。

### 10.2 消息存储流程详解

```
消息从 Producer 到磁盘的完整流程：

1. Producer 发送消息到 Broker
2. Broker 接收到消息后，进行以下处理：
   a. 消息序列化（MessageSerializer）
   b. 获取 CommitLog 文件锁（putMessageLock，支持自旋锁和重入锁）
   c. 将消息追加写入 CommitLog 的 MappedFile
   d. 根据刷盘策略决定是否立即 flush
3. 后台线程 ReputMessageService 持续从 CommitLog 读取新消息：
   a. 构建 ConsumeQueue 条目，写入对应的 ConsumeQueue 文件
   b. 构建 IndexFile 条目，写入 IndexFile
4. Consumer 从 ConsumeQueue 读取偏移量，再从 CommitLog 读取完整消息体
```

### 10.3 MappedFile 内存映射

RocketMQ 使用 Java NIO 的 `MappedByteBuffer` 将文件映射到内存，实现了"写入内存即写入文件"的效果：

```java
// 简化的 MappedFile 写入过程
MappedByteBuffer mappedBuffer = channel.map(
    FileChannel.MapMode.READ_WRITE, 0, fileSize);

// 写入消息到映射的内存区域
mappedBuffer.put(messageBytes);

// 同步刷盘：强制将内存数据刷入磁盘
mappedBuffer.force();
```

这种设计的优势在于：写入操作直接操作内存，无需经历传统的 write() 系统调用，减少了用户态到内核态的切换开销。同时，操作系统会利用 PageCache 机制自动管理内存页的换入换出，实现了高效的 IO 操作。

### 10.4 消息过期与删除

RocketMQ 的消息删除策略采用"基于时间 + 基于空间"双重机制：

- **时间策略**：消息默认保留 72 小时，由 `fileReservedTime` 参数控制
- **空间策略**：当磁盘使用率超过 85% 时开始删除最老的文件，超过 95% 时禁止写入

删除操作在凌晨 4:00 执行（可配置），每次最多删除 10 个 CommitLog 文件。删除前会检查是否有 Consumer 还未消费到该位置的消息。

---

## 十一、高可用部署与生产实践

### 11.1 Broker 集群部署架构

生产环境中推荐的 Broker 部署方案：

```
推荐的生产部署架构（2Master-2Slave）：

         NameServer-1    NameServer-2    NameServer-3
              │               │               │
    ┌─────────┼───────────────┼───────────────┼─────────┐
    │         │               │               │         │
┌───v──┐  ┌──v───┐      ┌────v───┐      ┌────v───┐
│Master│  │Slave │      │Master  │      │Slave   │
│-A    │←→│-A    │      │-B      │←→   │-B      │
│      │  │      │      │        │      │        │
└──────┘  └──────┘      └────────┘      └────────┘
  主节点A    从节点A         主节点B         从节点B

配置要点：
- 每个 Master 配一个 Slave，保证数据冗余
- NameServer 至少 3 个节点，保证路由信息高可用
- 生产者和消费者配置所有 NameServer 地址
```

### 11.2 性能调优参数

```properties
# broker.conf 生产环境推荐配置

# === 刷盘与复制 ===
flushDiskType=SYNC_FLUSH          # 同步刷盘（金融级）或 ASYNC_FLUSH（高性能）
brokerRole=SYNC_MASTER            # 同步复制或 ASYNC_MASTER

# === 性能优化 ===
sendMessageThreadPoolNums=1       # 发送线程数（使用顺序消息时设为1）
useReentrantLockWhenPutMessage=true  # 使用重入锁代替自旋锁
osPageCacheBusyTimeOutMills=1000 # PageCache 繁忙超时时间

# === 内存管理 ===
transferMsgByHeap=true            # 通过堆内存传输消息（减少 DirectMemory 压力）
maxTransferCountOnHeapInDisk=8192 # 磁盘消息通过堆传输的最大数量

# === 消费优化 ===
consumeMessageBatchMaxSize=32     # 单次消费最大消息数
pullMessageThreadPoolNums=64      # 拉取消息线程数

# === 存储优化 ===
mapedFileSizeCommitLog=1073741824 # CommitLog 文件大小（1GB）
flushCommitLogTimed=true          # 定时刷盘
flushCommitLogInterval=500        # 刷盘间隔（毫秒）
```

### 11.3 监控与告警

生产环境中必须关注的 RocketMQ 监控指标：

```
核心监控指标：

1. 消息积压量（Consumer Offset Diff）
   - 正常：< 1000 条
   - 告警阈值：> 10000 条
   - 严重：> 100000 条

2. 发送 TPS 与消费 TPS
   - 发送 TPS 持续远大于消费 TPS → 即将积压

3. 发送延迟
   - 同步发送 P99 延迟应 < 10ms
   - 超过 100ms 需要排查 Broker 磁盘 IO

4. Broker 磁盘使用率
   - 告警阈值：> 75%
   - 危险阈值：> 85%（开始删除旧消息）

5. PageCache 繁忙时间
   - 超过 200ms 说明磁盘 IO 成为瓶颈
```

### 11.4 常见生产故障与排查

**故障一：消息发送超时**

排查步骤：首先检查 Broker 磁盘 IO 是否正常（`iostat -x 1`），其次检查网络延迟（`ping` 和 `telnet`），最后查看 Broker 日志中是否有 `PAGECACHE_BUSY` 告警。如果 PageCache 繁忙，说明写入速度跟不上消息产生速度，需要扩容或降低发送频率。

**故障二：消费延迟突增**

排查步骤：检查消费者的 GC 日志，确认是否存在 Full GC；查看消费线程池是否饱和；检查下游依赖服务（数据库、缓存）的响应时间。常见根因是消费逻辑中包含了慢查询或外部调用超时。

**故障三：Broker 主从切换后消息不一致**

在异步复制模式下，Master 宕机时可能存在少量消息未同步到 Slave。切换到 Slave 后，这些消息将"丢失"。解决方案：对于关键业务使用同步复制，或在应用层维护消息发送日志表进行对账补偿。

---

## 十二、RocketMQ 与 Kafka 对比选型

```
RocketMQ vs Kafka 核心对比：

维度              RocketMQ                    Kafka
───────────────  ─────────────────────────   ────────────────────────
设计目标          企业级消息中间件              分布式日志流平台
消息模型          Topic + MessageQueue          Topic + Partition
存储方式          所有Topic共用CommitLog        每个Partition独立文件
消息可靠性        同步刷盘+同步复制             ISR 机制
事务消息          原生支持                      0.11+ 支持（较轻量）
延迟消息          原生支持（18个等级）           不支持（需自研）
死信队列          原生支持                      不支持
消息回溯          支持按时间戳回溯               支持按偏移量/时间回溯
吞吐量            十万级 TPS                    百万级 TPS
适用场景          金融交易、电商订单             日志采集、大数据管道
生态集成          Spring Cloud Alibaba          Spark、Flink、Kafka Streams
```

选型建议：如果你的场景是金融交易、电商订单等需要事务消息和延迟消息的企业级应用，RocketMQ 是更好的选择。如果你的场景是海量日志采集、大数据实时分析，Kafka 的高吞吐和丰富的生态工具更为合适。

---

## 十三、面试题精选

### Q1：RocketMQ 如何保证消息不丢失？

**答**：从三个维度保障：
1. **生产端**：使用同步发送，失败重试；核心业务避免使用 Oneway
2. **存储端**：配置同步刷盘（SYNC_FLUSH）确保数据落盘，配置同步复制（SYNC_MASTER）确保 Slave 有完整备份
3. **消费端**：消费失败返回 RECONSUME_LATER 触发重试，不吞异常；确保消费逻辑的健壮性

### Q2：RocketMQ 如何保证消息顺序？

**答**：
- **发送端**：通过 MessageQueueSelector 将需要保序的消息发送到同一个 MessageQueue
- **消费端**：使用 MessageListenerOrderly 顺序消费监听器，RocketMQ 会对同一个 MessageQueue 加锁，保证同一时刻只有一个线程消费

### Q3：RocketMQ 的事务消息原理？

**答**：采用两阶段提交 + 事务回查机制。第一阶段发送 half 消息（对消费者不可见），执行本地事务后根据结果 COMMIT 或 ROLLBACK。如果 COMMIT/ROLLBACK 未到达 Broker，Broker 会主动回查 Producer 的事务状态。

### Q4：RocketMQ 如何实现高可用？

**答**：
- NameServer 多节点部署，无状态设计
- Broker 采用 Master-Slave 架构，Master 宕机后 Slave 可提供读服务
- 消费者集群部署，支持自动 Rebalance
- Producer 支持自动重试和故障 Broker 规避

### Q5：RocketMQ 消息积压怎么处理？

**答**：
1. **紧急扩容**：增加 Consumer 实例数量（不超过 MessageQueue 数量）
2. **临时转移**：写一个临时 Consumer，将积压消息快速转发到新的 Topic（更多分区），然后用更多 Consumer 并行消费
3. **跳过非重要消息**：如果积压消息可以丢弃，直接重置消费位点到最新位置
4. **优化消费逻辑**：排查消费慢的根因，优化业务处理速度或批量处理

### Q6：Push 模式和 Pull 模式的选择？

**答**：Push 模式适合大多数场景，其长轮询机制兼顾了实时性和资源效率。Pull 模式适合需要精确控制消费速率、批量处理的场景。RocketMQ 5.0 的 POP 模式结合了两者优点，推荐在新项目中使用。

---

## 总结

RocketMQ 之所以能在金融级场景中得到广泛应用，核心在于其对消息可靠性的极致追求——从同步刷盘到同步复制，从事务消息到延迟投递，每一个环节都考虑了极端情况下的数据安全保障。理解这些原理，不仅能帮助我们在面试中脱颖而出，更能在实际架构设计中做出正确的取舍决策。

在实际项目中，建议根据业务场景选择合适的可靠性级别：日志类应用可以使用异步刷盘 + 异步复制以换取高吞吐；交易类应用则必须使用同步刷盘 + 同步复制以确保万无一失。
