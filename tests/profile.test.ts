import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import * as WeCom from '../src/index.js'
import { SETTINGS_NS, WeComWebBackend } from '../src/settings-web.js'

vi.mock('../src/cli.js', () => ({
  WeComCliService: class {
    probe = async () => ({ installed: false, meetsMin: false, auth: 'unknown' })
    dispose = () => {}
  },
}))

describe('DSH 0.2 profile composition', () => {
  it('loads the plugin, persists live settings without remounting, and restores them at restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wecom-profile-'))
    const dir = join(home, 'profiles', 'test')
    let ctx: Awaited<ReturnType<typeof boot>> | undefined
    const output = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      initProfile(dir, ['test-bundle'])
      const bundle = join(dir, 'node_modules', 'test-bundle')
      await mkdir(bundle, { recursive: true })
      await writeFile(join(home, 'package.json'), '{"name":"wecom-test-installation"}')
      await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
      await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'config-editor', name: 'cordis:editor' },
        { id: 'settings', name: 'cordis:settings' },
        { id: SETTINGS_NS, name: 'cordis:wecom', config: { cwd: home } },
      ] }]))
      await writeFile(join(dir, 'cordis.yml'), '[]')
      const profile: ProfileContext = {
        name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
        installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
      }
      const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
        root.provide('profileContext', profile)
        root.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
        // No network or model calls: an unconfigured channel must stay dormant.
        for (const name of WeCom.inject) root.provide(name, (name === 'credentials'
          ? { describe: async () => ({ configured: false, writable: true }) }
          : {}) as never)
        Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, wecom: WeCom })
      })
      ctx = await start()
      ctx.logger(WeCom.name).info('terminal exporter check')
      expect(output).toHaveBeenCalledWith('[wecom-plus] %s', 'terminal exporter check')
      const descriptor = () => ctx!.settings.describe().find(row => row.ns === SETTINGS_NS)!
      const entry = [...ctx.loader.entries()].find(row => row.options.id === SETTINGS_NS)!
      const fiber = entry.fiber
      expect(descriptor().autoGenerate).toBe(false)
      expect(descriptor().value).toMatchObject({ botId: '', cwd: home })
      const backend = new WeComWebBackend(ctx, () => ({ state: 'inactive' }))
      expect((await backend.snapshot()).credential.configured).toBe(false)
      await ctx.settings.update(SETTINGS_NS, { welcomeText: '新版设置已保存', workspaces: [home] }, descriptor().revision)
      expect(entry.fiber).toBe(fiber)
      expect(descriptor().value).toMatchObject({ welcomeText: '新版设置已保存', workspaces: [home] })
      expect(await readFile(profile.patchPath, 'utf8')).toContain('新版设置已保存')
      await expect(ctx.settings.update(SETTINGS_NS, { questionTimeoutMs: 1 })).rejects.toThrow()
      await ctx.fiber.dispose()
      output.mockClear()
      ctx.logger(WeCom.name).info('disposed exporter check')
      expect(output).not.toHaveBeenCalled()
      ctx = await start()
      expect(descriptor().value).toMatchObject({ welcomeText: '新版设置已保存', workspaces: [home] })
    } finally {
      await ctx?.fiber.dispose()
      output.mockRestore()
      await rm(home, { recursive: true, force: true })
    }
  })
})
