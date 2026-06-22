// Theme entry - extend default VitePress theme
import DefaultTheme from 'vitepress/theme'
import './styles/custom.css'
import './styles/vars.css'
import BlogList from './components/BlogList.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('BlogList', BlogList)
  }
}
