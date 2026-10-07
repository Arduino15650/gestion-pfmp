import React from 'react';
import {createRoot} from 'react-dom/client';
import AccessGate from './access-gate';
import './globals.css';
import './theme.css';
import './compact.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><AccessGate/></React.StrictMode>);
