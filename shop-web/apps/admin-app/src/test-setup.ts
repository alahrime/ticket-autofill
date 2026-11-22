// Vitest runs without globals, so Testing Library's own afterEach cleanup isn't hooked: unmount here.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
