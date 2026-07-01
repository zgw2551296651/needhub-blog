<template>
  <div class="blog-list-container">
    <!-- Category Filter Tabs -->
    <div class="filter-bar">
      <button
        v-for="cat in categories"
        :key="cat.value"
        :class="['filter-tab', { active: activeCategory === cat.value }]"
        @click="activeCategory = cat.value"
      >
        <span class="filter-dot" :style="{ background: cat.color }"></span>
        {{ cat.label }}
      </button>
    </div>

    <!-- Blog Cards Grid -->
    <div class="blog-grid">
      <BlogCard
        v-for="post in filteredPosts"
        :key="post.slug"
        :post="post"
      />
    </div>

    <!-- Empty State -->
    <div v-if="filteredPosts.length === 0" class="empty-state">
      <p>该分类下暂无文章，敬请期待！</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import BlogCard from './BlogCard.vue'
import postsData from '../../../blog/posts/_posts.json'

const categories = [
  { value: 'all', label: '全部', color: '#3B82F6' },
  { value: 'java-core', label: 'Java核心', color: '#EF4444' },
  { value: 'database', label: '数据库', color: '#3B82F6' },
  { value: 'middleware', label: '框架中间件', color: '#6366F1' },
  { value: 'distributed', label: '分布式架构', color: '#10B981' },
  { value: 'fundamentals', label: '基础内功', color: '#F59E0B' },
  { value: 'design', label: '方案设计', color: '#8B5CF6' },
  { value: 'ai-models', label: 'AI大模型', color: '#F97316' },
  { value: 'software', label: '软件推荐', color: '#06B6D4' }
]

const activeCategory = ref('all')

// Read category from URL query params
onMounted(() => {
  const params = new URLSearchParams(window.location.search)
  const cat = params.get('category')
  if (cat && categories.some(c => c.value === cat)) {
    activeCategory.value = cat
  }
})

const filteredPosts = computed(() => {
  const posts = postsData.posts || []
  if (activeCategory.value === 'all') return posts
  return posts.filter(p => p.category === activeCategory.value)
})
</script>

<style scoped>
.blog-list-container {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px 24px 48px;
}

/* ---- Filter Bar ---- */
.filter-bar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 32px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--nh-border);
}

.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border: 1px solid var(--nh-border);
  border-radius: 20px;
  background: var(--nh-bg-card);
  color: var(--nh-text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  font-family: inherit;
}
.filter-tab:hover {
  border-color: var(--nh-brand);
  color: var(--nh-brand);
}
.filter-tab.active {
  background: var(--nh-brand);
  border-color: var(--nh-brand);
  color: #fff;
}

.filter-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.filter-tab.active .filter-dot {
  background: #fff !important;
}

/* ---- Blog Grid ---- */
.blog-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 24px;
}

/* ---- Empty State ---- */
.empty-state {
  text-align: center;
  padding: 80px 20px;
  color: var(--nh-text-secondary);
  font-size: 16px;
}

@media (max-width: 640px) {
  .blog-grid {
    grid-template-columns: 1fr;
  }
  .blog-list-container {
    padding: 16px 16px 32px;
  }
}
</style>
