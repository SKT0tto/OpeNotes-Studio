import { describe, expect, it } from 'vitest';
import { USER_BG_ID_RE, isUserBg, uploadBgName, uploadTargetSize, userBgId } from '../../shared/catalog/uploadBg';

describe('uploadBg helpers', () => {
  it('id is user_ + 12 hex of the hash', () => {
    const id = userBgId('ABCDEF0123456789'.repeat(4));
    expect(id).toBe('user_abcdef012345');
    expect(USER_BG_ID_RE.test(id)).toBe(true);
    expect(isUserBg(id)).toBe(true);
    expect(isUserBg('user_xyz')).toBe(false);
    expect(isUserBg('12')).toBe(false);
  });
  it('name comes from the file name', () => {
    expect(uploadBgName('教室  夕阳.jpg')).toBe('教室 夕阳');
    expect(uploadBgName('C:\\pics\\sky.final.PNG')).toBe('sky.final');
    expect(uploadBgName(`${'a'.repeat(60)}.png`)).toBe('a'.repeat(40));
    expect(uploadBgName('.png')).toBe('上传的背景');
    expect(uploadBgName('   ')).toBe('上传的背景');
    expect(uploadBgName('')).toBe('上传的背景');
  });
  it('shrinks only when larger than needed to cover 2560x1440', () => {
    expect(uploadTargetSize(2560, 1440)).toEqual({ width: 2560, height: 1440 });
    expect(uploadTargetSize(5120, 2880)).toEqual({ width: 2560, height: 1440 });
    expect(uploadTargetSize(7680, 4320)).toEqual({ width: 2560, height: 1440 });
    expect(uploadTargetSize(3000, 6000)).toEqual({ width: 2560, height: 5120 });
    expect(uploadTargetSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(uploadTargetSize(400, 400)).toEqual({ width: 400, height: 400 });
  });
});

describe('delete warning / ignored files notice', () => {
  it('unused: simple confirm; used: names projects, total scenes, truncates long lists', async () => {
    const { deleteBgWarning, ignoredFilesNotice } = await import('../../shared/catalog/uploadBg');
    expect(deleteBgWarning([])).not.toMatch(/正在被/);
    expect(deleteBgWarning([{ title: '甲', scenes: 2 }, { title: '乙', scenes: 1 }])).toBe(
      '这张背景正在被 2 个项目使用：甲、乙（共 3 个场景）。删除后这些场景会显示为缺失背景，且无法撤销。确定删除吗？',
    );
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `项目${i}`, scenes: 1 }));
    expect(deleteBgWarning(many)).toMatch(/项目0、项目1、项目2、项目3、项目4等 8 个项目（共 8 个场景）/);
    expect(ignoredFilesNotice([])).toBe('');
    expect(ignoredFilesNotice(['a.txt', 'b.pdf'])).toBe('已忽略 2 个非图片文件：a.txt、b.pdf（支持 PNG / JPG / WebP）');
    expect(ignoredFilesNotice(['1', '2', '3', '4'])).toContain('1、2、3 等');
  });
});
