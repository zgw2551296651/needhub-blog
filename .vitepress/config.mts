import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'NeedHub',
  description: '分享计算机知识与好用软件推荐',
  lang: 'zh-CN',

  // GitHub Pages base path (change to your repo name)
  base: '/needhub-blog/',

  // Enable dark mode by default
  appearance: 'dark',

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
          { text: '技术分享', link: '/blog/?category=tech' },
          { text: '软件推荐', link: '/blog/?category=software' },
          { text: '学习笔记', link: '/blog/?category=notes' }
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
          text: '文章列表',
          items: [
            { text: '你好，世界 — 欢迎来到 NeedHub', link: '/blog/posts/hello-world' },
            { text: '2026 开发者必备工具', link: '/blog/posts/software-picks' }
          ]
        },
        {
          text: 'Java 学习笔记',
          items: [
            { text: 'Java 面试准备全攻略', link: '/blog/posts/java-interview-guide' },
            { text: 'JVM 深度解析', link: '/blog/posts/jvm-deep-dive' },
            { text: 'Java 并发编程核心原理', link: '/blog/posts/java-concurrency' },
            { text: 'Java 集合框架源码分析', link: '/blog/posts/java-collections' },
            { text: 'Spring 框架核心原理', link: '/blog/posts/spring-core-principles' },
            { text: 'Java 设计模式实战', link: '/blog/posts/java-design-patterns' }
          ]
        },
        {
          text: 'MySQL 学习笔记',
          items: [
            { text: 'MySQL 索引深度解析', link: '/blog/posts/mysql-index-deep-dive' },
            { text: 'MySQL 事务与锁机制', link: '/blog/posts/mysql-transaction-and-locks' },
            { text: 'MySQL SQL 优化实战', link: '/blog/posts/mysql-sql-optimization' }
          ]
        },
        {
          text: 'Redis 学习笔记',
          items: [
            { text: 'Redis 核心数据结构与底层实现', link: '/blog/posts/redis-data-structures' },
            { text: 'Redis 持久化、集群与高可用', link: '/blog/posts/redis-persistence-and-cluster' },
            { text: 'Redis 分布式锁与缓存一致性', link: '/blog/posts/redis-distributed-lock-and-cache' }
          ]
        },
        {
          text: '框架与中间件',
          items: [
            { text: 'MyBatis 核心原理与实战', link: '/blog/posts/mybatis-core-principles' },
            { text: 'SpringCloud 微服务架构全解析', link: '/blog/posts/springcloud-microservices' },
            { text: 'Kafka 消息队列深入解析', link: '/blog/posts/kafka-deep-dive' },
            { text: 'RocketMQ 原理与实战', link: '/blog/posts/rocketmq-principles' },
            { text: 'Elasticsearch 搜索引擎原理', link: '/blog/posts/elasticsearch-principles' },
            { text: 'Netty 网络编程核心原理', link: '/blog/posts/netty-core-principles' }
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
