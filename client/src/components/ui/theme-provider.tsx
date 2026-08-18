import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function EnhancedThemeProvider({ children }: ThemeProviderProps) {
  const { theme } = useTheme();
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    // Ensure theme is applied immediately on mount
    if (isMounted) {
      const root = document.documentElement;

      // Remove all theme classes first
      root.classList.remove('light', 'dark');

      // Add the current theme
      if (theme === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.add('light');
      }
    }
  }, [theme, isMounted]);

  // Check if we're in dark mode
  const isDarkMode =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (!isMounted) {
    return <>{children}</>;
  }

  return (
    <div className={`${isDarkMode ? 'dark' : 'light'} transition-colors duration-300`}>
      {children}
    </div>
  );
}

export function useEnhancedTheme() {
  const { theme, setTheme } = useTheme();

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);

    // Force immediate DOM update
    const root = document.documentElement;
    root.classList.remove('dark', 'light');
    root.classList.add(newTheme);
  };

  const isDarkMode =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return {
    theme,
    toggleTheme,
    isDarkMode,
    setTheme,
  };
}
