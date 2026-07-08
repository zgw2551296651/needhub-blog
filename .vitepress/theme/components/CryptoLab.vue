<template>
	<div class="crypto-lab-container" ref="container"></div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const container = ref(null)
let iframe = null

onMounted(() => {
	if (!container.value) return
	iframe = document.createElement('iframe')
	iframe.src = '/needhub-blog/crypto-lab.html'
	iframe.style.cssText = 'width:100%;height:calc(100vh - 64px);border:none;display:block;'
	container.value.appendChild(iframe)
})

onBeforeUnmount(() => {
	if (iframe && iframe.parentNode) {
		iframe.parentNode.removeChild(iframe)
	}
})
</script>

<style scoped>
.crypto-lab-container {
	width: 100%;
	margin-top: -24px;
}
</style>
