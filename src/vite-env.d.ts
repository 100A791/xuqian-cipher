/// <reference types="vite/client" />

declare module '*.css'

interface FileSystemEntry {
  readonly isFile: boolean
  readonly isDirectory: boolean
  readonly name: string
  readonly fullPath: string
}

interface FileSystemFileEntry extends FileSystemEntry {
  file(success: (file: File) => void, error?: (error: DOMException) => void): void
}

interface FileSystemDirectoryEntry extends FileSystemEntry {
  createReader(): FileSystemDirectoryReader
}

interface FileSystemDirectoryReader {
  readEntries(success: (entries: FileSystemEntry[]) => void, error?: (error: DOMException) => void): void
}
