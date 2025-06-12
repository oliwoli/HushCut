// src/context/AppContext.tsx
import React, { createContext, useState, useContext, ReactNode } from 'react';

interface AppContextType {
    isBusy: boolean;
    setIsBusy: (isBusy: boolean) => void;
}

// Create the context with a default value.
const AppContext = createContext<AppContextType | undefined>(undefined);

// Create a provider component.
export const AppProvider = ({ children }: { children: ReactNode }) => {
    // This state is our "lock". True if syncing or an alert is open.
    const [isBusy, setIsBusy] = useState(false);

    return (
        <AppContext.Provider value={{ isBusy, setIsBusy }}>
            {children}
        </AppContext.Provider>
    );
};

// Create a custom hook for easy access to the context.
export const useAppContext = () => {
    const context = useContext(AppContext);
    if (context === undefined) {
        throw new Error('useAppContext must be used within an AppProvider');
    }
    return context;
};