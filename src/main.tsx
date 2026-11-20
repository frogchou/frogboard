import { createRoot } from 'react-dom/client'
import App from './App'
import { FeedbackProvider } from './feedback/Feedback'
import './style.css'
import './conversations/conversations.css'
import { initializeAppearance } from './general/preferences'
import './general/theme.css'

initializeAppearance()
createRoot(document.getElementById('root')!).render(<FeedbackProvider><App /></FeedbackProvider>)
