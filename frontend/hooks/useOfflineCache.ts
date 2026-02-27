"use client";
import { useState, useEffect, useCallback } from "react";

const CACHE_NAME = "audio-cache-v1";

export function useOfflineCache(chapterId: string | null, audioUrl: string | null) {
  const [isCached, setIsCached] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    if (!chapterId || !audioUrl) return;
    checkCache(audioUrl).then(setIsCached);
  }, [chapterId, audioUrl]);

  const checkCache = async (url: string): Promise<boolean> => {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(url);
    return !!response;
  };

  const download = useCallback(async () => {
    if (!audioUrl || typeof caches === "undefined") return;
    setIsDownloading(true);
    try {
      const response = await fetch(audioUrl);
      const cache = await caches.open(CACHE_NAME);
      await cache.put(audioUrl, response);
      setIsCached(true);
    } catch (e) {
      console.error("Download failed:", e);
    } finally {
      setIsDownloading(false);
    }
  }, [audioUrl]);

  const remove = useCallback(async () => {
    if (!audioUrl || typeof caches === "undefined") return;
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(audioUrl);
    setIsCached(false);
  }, [audioUrl]);

  return { isCached, isDownloading, download, remove };
}
