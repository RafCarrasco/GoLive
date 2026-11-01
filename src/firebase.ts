import { initializeApp } from 'firebase/app';

import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey: 'AIzaSyDMW8WLXjug0v9QSes9a3pwDqa6MUqYDc0',
  authDomain: 'golive-ad118.firebaseapp.com',
  projectId: 'golive-ad118',
  storageBucket: 'golive-ad118.firebasestorage.app',
  messagingSenderId: '376998430369',
  appId: '1:376998430369:web:d1ab25dc2e7e50adf992e0',
  measurementId: 'G-EG6G1SNXHY',
  databaseURL:
    import.meta.env.VITE_FIREBASE_DATABASE_URL || 'https://golive-ad118-default-rtdb.firebaseio.com',
};
export const configured = Boolean(firebaseConfig.databaseURL);
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
