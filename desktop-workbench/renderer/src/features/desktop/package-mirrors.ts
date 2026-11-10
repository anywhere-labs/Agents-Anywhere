/**
 * Mirrors offered for the Connector environment. `labelKey` lives under
 * `pages.settings`. The chosen PyPI mirror is uv's first index and PyPI its
 * fallback, so a mirror that lacks a package (TUNA, USTC and BFSU carry no
 * openai-codex) still works.
 */
export const PYPI_MIRROR_OPTIONS = [
  { id: "default", url: "", labelKey: "desktopPypiDefault" },
  { id: "tsinghua", url: "https://pypi.tuna.tsinghua.edu.cn/simple", labelKey: "desktopPypiTsinghua" },
  { id: "ustc", url: "https://mirrors.ustc.edu.cn/pypi/simple", labelKey: "desktopPypiUstc" },
  { id: "bfsu", url: "https://mirrors.bfsu.edu.cn/pypi/web/simple", labelKey: "desktopPypiBfsu" },
  { id: "aliyun", url: "https://mirrors.aliyun.com/pypi/simple", labelKey: "desktopPypiAliyun" },
  { id: "tencent", url: "https://mirrors.cloud.tencent.com/pypi/simple", labelKey: "desktopPypiTencent" },
  { id: "huawei", url: "https://repo.huaweicloud.com/repository/pypi/simple", labelKey: "desktopPypiHuawei" },
] as const

export const PYTHON_MIRROR_OPTIONS = [
  { id: "default", url: "", labelKey: "desktopPythonMirrorDefault" },
  { id: "npmmirror", url: "https://registry.npmmirror.com/-/binary/python-build-standalone", labelKey: "desktopPythonMirrorNpmmirror" },
] as const
