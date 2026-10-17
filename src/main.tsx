import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { syncDocumentChrome } from './app/store.ts'
import { registerOfflineShell } from './app/pwa.ts'
import './app/index.css'

syncDocumentChrome()
registerOfflineShell()

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
