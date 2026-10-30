"use client"

import * as React from "react"

export function createSidebarVisibility(STORAGE_KEY: string, CHANGE_EVENT: string) {
  let fallbackVisibility = true
  
  function readVisibility(): boolean {
    if (typeof window === "undefined") return true
  
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      return stored === null ? true : stored !== "false"
    } catch {
      return fallbackVisibility
    }
  }
  
  function subscribe(listener: () => void): () => void {
    window.addEventListener("storage", listener)
    window.addEventListener(CHANGE_EVENT, listener)
  
    return () => {
      window.removeEventListener("storage", listener)
      window.removeEventListener(CHANGE_EVENT, listener)
    }
  }
  
  function setVisible(visible: boolean): void {
    fallbackVisibility = visible
  
    try {
      window.localStorage.setItem(STORAGE_KEY, String(visible))
    } catch {
      // Keep the in-memory value when local storage is unavailable.
    }
  
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }
  
  function useVisibility(): readonly [
    boolean,
    (visible: boolean) => void,
  ] {
    const visible = React.useSyncExternalStore(subscribe, readVisibility, () => true)
    return [visible, setVisible] as const
  }

  return { useVisibility, setVisible }
}
