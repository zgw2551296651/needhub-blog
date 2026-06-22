<template>
  <a :href="postUrl" class="blog-card">
    <div class="card-content">
      <!-- Category Badge -->
      <div class="card-meta">
        <span class="category-badge" :style="badgeStyle">
          {{ categoryLabel }}
        </span>
        <span class="post-date">{{ formattedDate }}</span>
      </div>

      <!-- Title & Excerpt -->
      <h3 class="card-title">{{ post.title }}</h3>
      <p class="card-excerpt">{{ post.excerpt }}</p>

      <!-- Tags -->
      <div class="card-tags" v-if="post.tags && post.tags.length">
        <span v-for="tag in post.tags" :key="tag" class="tag">#{{ tag }}</span>
      </div>

      <!-- Read More -->
      <div class="card-footer">
        <span class="read-more">阅读更多 &rarr;</span>
      </div>
    </div>
  </a>
</template>

<script setup>
import { computed } from 'vue'
import { withBase } from 'vitepress'

const props = defineProps({
  post: {
    type: Object,
    required: true
  }
})

const categoryMap = {
  tech: { label: '技术分享', color: '#3B82F6' },
  software: { label: '软件推荐', color: '#10B981' },
  notes: { label: '学习笔记', color: '#F59E0B' }
}

const postUrl = computed(() => withBase(`/blog/posts/${props.post.slug}`))

const categoryLabel = computed(() => {
  const cat = categoryMap[props.post.category]
  return cat ? cat.label : props.post.category
})

const badgeStyle = computed(() => {
  const cat = categoryMap[props.post.category]
  return cat
    ? { background: `${cat.color}18`, color: cat.color, borderColor: `${cat.color}30` }
    : {}
})

const formattedDate = computed(() => {
  if (!props.post.date) return ''
  const d = new Date(props.post.date)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
})
</script>

<style scoped>
.blog-card {
  display: block;
  text-decoration: none;
  color: inherit;
  background: var(--nh-bg-card);
  border: 1px solid var(--nh-border);
  border-radius: var(--nh-radius);
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  cursor: pointer;
}
.blog-card:hover {
  border-color: var(--nh-brand);
  box-shadow: var(--nh-shadow-glow);
  transform: translateY(-4px);
}

.card-content {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---- Meta Row ---- */
.card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.category-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid;
  letter-spacing: 0.02em;
}

.post-date {
  font-size: 13px;
  color: var(--nh-text-secondary);
  white-space: nowrap;
}

/* ---- Title ---- */
.card-title {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  margin: 0;
  color: var(--nh-text);
  letter-spacing: -0.01em;
}

/* ---- Excerpt ---- */
.card-excerpt {
  font-size: 14px;
  line-height: 1.65;
  color: var(--nh-text-secondary);
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ---- Tags ---- */
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  font-size: 12px;
  color: var(--nh-brand);
  background: var(--nh-brand-glow);
  padding: 2px 8px;
  border-radius: 4px;
}

/* ---- Footer ---- */
.card-footer {
  margin-top: 4px;
}
.read-more {
  font-size: 13px;
  font-weight: 500;
  color: var(--nh-brand);
  transition: color 0.2s;
}
.blog-card:hover .read-more {
  color: var(--nh-brand-light);
}
</style>
