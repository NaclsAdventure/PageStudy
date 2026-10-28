import { createRoot } from 'react-dom/client';
import OptionsApp from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('PageStudy options root not found');

createRoot(rootElement).render(<OptionsApp />);
