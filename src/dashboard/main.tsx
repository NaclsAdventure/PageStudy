import { createRoot } from 'react-dom/client';
import DashboardApp from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('PageStudy dashboard root not found');

createRoot(rootElement).render(<DashboardApp />);
