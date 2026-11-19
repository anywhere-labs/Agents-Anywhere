import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/styles/web.css'
import { App } from './app'

// ?theme=dark|light (screenshots) overrides the saved choice.
const theme = new URLSearchParams(location.search).get('theme')
if (theme) document.documentElement.classList.toggle('dark', theme === 'dark')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
)
