import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, inMemoryPersistence, setPersistence } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase } from 'firebase/database';

// `npm run dev:local` usa os emuladores locais (projeto demo-nimbo) em vez do Firebase real.
export const useEmulators = import.meta.env.MODE === 'emulator';

export const firebaseConfig = useEmulators
  ? {
      apiKey: 'demo-key',
      authDomain: 'demo-nimbo.firebaseapp.com',
      projectId: 'demo-nimbo',
      appId: 'demo-nimbo',
      databaseURL: 'http://127.0.0.1:9000?ns=demo-nimbo-default-rtdb',
    }
  : {
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

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

if (useEmulators) {
  connectDatabaseEmulator(db, '127.0.0.1', 9000);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  // Cada aba vira um usuário independente nos testes locais.
  void setPersistence(auth, inMemoryPersistence);
}
