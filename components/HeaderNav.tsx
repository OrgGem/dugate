'use client';
// components/HeaderNav.tsx — Flat Material Enterprise Navigation Bar

import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { 
  Home, SlidersHorizontal, PlugZap, User, LogOut, Users, ChevronDown, 
  LogIn, BrainCircuit, Settings, Zap, History, BarChart2, BookOpen 
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';

export default function HeaderNav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (pathname === '/login' || pathname === '/setup') return null;

  const isAdmin = session?.user?.role === 'ADMIN';
  const isViewer = session?.user?.role === 'VIEWER';

  return (
    <header className="glass-header sticky top-0 z-40 bg-card border-b border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        {/* Logo & Brand */}
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="bg-primary text-primary-foreground p-1.5 rounded-md flex items-center justify-center">
              <BrainCircuit className="w-4 h-4" />
            </div>
            <span className="text-base font-bold tracking-tight text-foreground whitespace-nowrap">
              DUGate
            </span>
            <span className="text-[11px] font-mono font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded border border-border">
              v{process.env.NEXT_PUBLIC_APP_VERSION || '2.0'}
            </span>
          </Link>

          {/* Primary Nav Links */}
          <nav className="hidden md:flex items-center gap-1">
            <Link
              href="/"
              className={`pill-nav-item ${
                pathname === '/' ? 'pill-nav-active' : 'pill-nav-inactive'
              }`}
            >
              <Home className="w-4 h-4" />
              <span>Tổng quan</span>
            </Link>

            <Link
              href="/history"
              className={`pill-nav-item ${
                pathname.startsWith('/history') || pathname.startsWith('/operations') ? 'pill-nav-active' : 'pill-nav-inactive'
              }`}
            >
              <History className="w-4 h-4" />
              <span>Lịch sử Operations</span>
            </Link>

            {!isViewer && (
              <Link
                href="/dashboard"
                className={`pill-nav-item ${
                  pathname.startsWith('/dashboard') ? 'pill-nav-active' : 'pill-nav-inactive'
                }`}
              >
                <BarChart2 className="w-4 h-4" />
                <span>Dashboard</span>
              </Link>
            )}

            {!isViewer && (
              <Link
                href="/profiles"
                className={`pill-nav-item ${
                  pathname.startsWith('/profiles') ? 'pill-nav-active' : 'pill-nav-inactive'
                }`}
              >
                <SlidersHorizontal className="w-4 h-4" />
                <span>Profiles</span>
              </Link>
            )}

            {isAdmin && (
              <Link
                href="/api-connections"
                className={`pill-nav-item ${
                  pathname.startsWith('/api-connections') ? 'pill-nav-active' : 'pill-nav-inactive'
                }`}
              >
                <PlugZap className="w-4 h-4" />
                <span>Connections</span>
              </Link>
            )}

            {isAdmin && (
              <Link
                href="/workflow-builder"
                className={`pill-nav-item ${
                  pathname.startsWith('/workflow-builder') ? 'pill-nav-active' : 'pill-nav-inactive'
                }`}
              >
                <Zap className="w-4 h-4" />
                <span>Workflows</span>
              </Link>
            )}

            <Link
              href="/api-docs"
              className={`pill-nav-item ${
                pathname.startsWith('/api-docs') ? 'pill-nav-active' : 'pill-nav-inactive'
              }`}
            >
              <BookOpen className="w-4 h-4" />
              <span>API Docs</span>
            </Link>
          </nav>
        </div>

        {/* Right Nav / Controls */}
        <div className="flex items-center gap-2">
          {session?.user ? (
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-2.5 py-1.5 text-sm font-medium rounded-md border border-border bg-card hover:bg-muted transition-colors"
                aria-expanded={showDropdown}
              >
                <div className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
                  {(session.user.username || session.user.name || 'U').charAt(0).toUpperCase()}
                </div>
                <span className="text-foreground max-w-[120px] truncate hidden sm:inline">
                  {session.user.username || session.user.name}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${showDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showDropdown && (
                <div className="absolute right-0 mt-1.5 w-60 rounded-md bg-card border border-border shadow-md overflow-hidden z-50 animate-in fade-in duration-150">
                  {/* User Header */}
                  <div className="px-4 py-2.5 border-b border-border bg-muted/40">
                    <p className="text-sm font-semibold text-foreground truncate">
                      {session.user.username || session.user.name}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                      {session.user.role === 'ADMIN' ? 'Admin / Superuser' : session.user.role === 'VIEWER' ? 'Read-only Viewer' : 'Standard User'}
                    </p>
                  </div>

                  {/* Menu Items */}
                  <div className="p-1 space-y-0.5">
                    {isAdmin && (
                      <Link
                        href="/settings"
                        onClick={() => setShowDropdown(false)}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-foreground rounded hover:bg-muted transition-colors"
                      >
                        <Settings className="w-4 h-4 text-muted-foreground" />
                        <span>Cài đặt hệ thống</span>
                      </Link>
                    )}
                    {isAdmin && (
                      <Link
                        href="/settings/users"
                        onClick={() => setShowDropdown(false)}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-foreground rounded hover:bg-muted transition-colors"
                      >
                        <Users className="w-4 h-4 text-muted-foreground" />
                        <span>Quản lý người dùng</span>
                      </Link>
                    )}
                    
                    <div className="my-1 border-t border-border" />
                    
                    <div className="px-3 py-1.5 flex items-center justify-between text-xs text-muted-foreground">
                      <span>Giao diện:</span>
                      <ThemeToggle />
                    </div>
                    
                    <div className="my-1 border-t border-border" />
                    
                    <button
                      onClick={() => signOut({ callbackUrl: `${window.location.origin}/login` })}
                      className="flex items-center gap-2 px-3 py-2 text-sm text-destructive rounded hover:bg-destructive/10 transition-colors w-full text-left"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Đăng xuất</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <Link
              href="/login"
              className="btn-primary inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>Đăng nhập</span>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
