import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'
import { initializeAppearance } from './general/preferences'
import './general/theme.css'

initializeAppearance()
createRoot(document.getElementById('root')!).render(<App />)
