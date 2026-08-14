import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** Canonical local file accepted for a WeCom outbound upload. */
export interface OutboundFile {
  path: string
  name: string
  bytes: number
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isOutside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)
}

/**
 * Resolve one model-requested path to a regular file under the configured WeCom workspace.
 * Symlinks are resolved before containment is checked.
 * @param cwd - Absolute configured WeCom workspace.
 * @param requestedPath - Absolute or workspace-relative model argument.
 * @param maxBytes - Configured upload-size ceiling.
 * @returns Canonical file metadata for the SDK upload.
 */
export async function resolveOutboundFile(
  cwd: string,
  requestedPath: string,
  maxBytes: number,
): Promise<OutboundFile> {
  if (requestedPath.trim().length === 0) throw new Error('wecom_send_file: path must not be empty')

  let root: string
  try {
    root = await realpath(cwd)
  } catch (error) {
    if (isMissing(error)) throw new Error(`wecom_send_file: configured cwd does not exist: ${JSON.stringify(cwd)}`)
    throw error
  }
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory()) {
    throw new Error(`wecom_send_file: configured cwd is not a directory: ${JSON.stringify(cwd)}`)
  }

  const unresolved = isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath)
  let path: string
  try {
    path = await realpath(unresolved)
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`wecom_send_file: file does not exist: ${JSON.stringify(requestedPath)}`)
    }
    throw error
  }
  if (isOutside(root, path)) {
    throw new Error(`wecom_send_file: file resolves outside configured cwd: ${JSON.stringify(requestedPath)}`)
  }

  const info = await stat(path)
  if (!info.isFile()) throw new Error(`wecom_send_file: path is not a regular file: ${JSON.stringify(requestedPath)}`)
  if (info.size > maxBytes) {
    throw new Error(`wecom_send_file: file is ${info.size} bytes; configured limit is ${maxBytes} bytes`)
  }
  return { path, name: basename(path), bytes: info.size }
}
