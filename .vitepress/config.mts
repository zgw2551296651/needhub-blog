import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'NeedHub',
  description: '分享计算机知识与好用软件推荐',
  lang: 'zh-CN',

  // GitHub Pages base path (change to your repo name)
  base: '/needhub-blog/',

  // Default to light mode (white background)
  appearance: 'light',

  themeConfig: {
    // Site logo
    logo: '/logo.svg',

    // Navigation bar
    nav: [
      { text: '首页', link: '/' },
      { text: '博客', link: '/blog/' },
      { text: '关于', link: '/about/' },
      {
        text: '分类',
        items: [
          { text: 'Java核心', link: '/blog/?category=java-core' },
          { text: '数据库', link: '/blog/?category=database' },
          { text: '框架中间件', link: '/blog/?category=middleware' },
          { text: '分布式架构', link: '/blog/?category=distributed' },
          { text: '基础内功', link: '/blog/?category=fundamentals' },
          { text: '方案设计', link: '/blog/?category=design' },
          { text: 'AI大模型', link: '/blog/?category=ai-models' },
          { text: '软件推荐', link: '/blog/?category=software' }
        ]
      }
    ],

    // Social links
    socialLinks: [
      { icon: 'github', link: 'https://github.com/' }
    ],

    // Footer
    footer: {
      message: '基于 MIT 许可证发布',
      copyright: 'Copyright © 2026 NeedHub'
    },

    // Search
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索',
            buttonAriaLabel: '搜索'
          },
          modal: {
            noResultsText: '未找到相关结果',
            resetButtonTitle: '重置搜索',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    },

    // Dark mode toggle
    darkModeSwitchLabel: '主题',
    darkModeSwitchTitle: '切换到亮色模式',
    lightModeSwitchTitle: '切换到暗色模式',

    // Back to top
    outline: {
      label: '页面导航'
    },

    // Last updated
    lastUpdated: {
      text: '最后更新于'
    },

    // Doc footer
    docFooter: {
      prev: '上一篇',
      next: '下一篇'
    },

    // Return to top button
    returnToTopLabel: '回到顶部',

    // Sidebar (for blog posts)
    sidebar: {
      '/blog/posts/': [
        {
          text: 'Java核心',
          items: [
            { text: '你好，世界 — 欢迎来到 NeedHub', link: '/blog/posts/hello-world' },
            { text: 'Java 面试准备全攻略', link: '/blog/posts/java-interview-guide' },
            { text: 'JVM 深度解析', link: '/blog/posts/jvm-deep-dive' },
            { text: 'Java 并发编程核心原理', link: '/blog/posts/java-concurrency' },
            { text: 'Java 集合框架源码分析', link: '/blog/posts/java-collections' },
            { text: 'Java 设计模式实战', link: '/blog/posts/java-design-patterns' }
          ]
        },
        {
          text: '数据库',
          items: [
            { text: 'MySQL 索引深度解析', link: '/blog/posts/mysql-index-deep-dive' },
            { text: 'MySQL 事务与锁机制', link: '/blog/posts/mysql-transaction-and-locks' },
            { text: 'MySQL SQL 优化实战', link: '/blog/posts/mysql-sql-optimization' },
            { text: 'Redis 核心数据结构与底层实现', link: '/blog/posts/redis-data-structures' },
            { text: 'Redis 持久化、集群与高可用', link: '/blog/posts/redis-persistence-and-cluster' },
            { text: 'Redis 分布式锁与缓存一致性', link: '/blog/posts/redis-distributed-lock-and-cache' }
          ]
        },
        {
          text: '框架中间件',
          items: [
            { text: 'Spring 框架核心原理', link: '/blog/posts/spring-core-principles' },
            { text: 'MyBatis 核心原理与实战', link: '/blog/posts/mybatis-core-principles' },
            { text: 'SpringCloud 微服务架构全解析', link: '/blog/posts/springcloud-microservices' },
            { text: 'Kafka 消息队列深入解析', link: '/blog/posts/kafka-deep-dive' },
            { text: 'RocketMQ 原理与实战', link: '/blog/posts/rocketmq-principles' },
            { text: 'Elasticsearch 搜索引擎原理', link: '/blog/posts/elasticsearch-principles' },
            { text: 'Netty 网络编程核心原理', link: '/blog/posts/netty-core-principles' }
          ]
        },
        {
          text: '软件推荐',
          items: [
            { text: '2026 开发者必备工具', link: '/blog/posts/software-picks' }
          ]
        }
      ]
    }
  },

  // Build optimization
  vite: {
    build: {
      chunkSizeWarningLimit: 1024
    }
  }
})
