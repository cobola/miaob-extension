// 错误类型
export enum ErrorType {
  TYPO = 'typo',           // 错别字
  GRAMMAR = 'grammar',     // 语法错误
  PUNCTUATION = 'punctuation', // 标点错误
  SENSITIVE = 'sensitive', // 规范/敏感用语
}

// 检查严格程度
export enum Strictness {
  BASIC = 'basic',       // 基础：只检查明显错误
  STANDARD = 'standard', // 标准：常规检查
  STRICT = 'strict',     // 严格：全面检查
}

// 错误信息
export interface TextError {
  type: ErrorType
  start: number
  end: number
  message: string
  suggestion?: string
  original: string
}

// 检查请求
export interface CheckRequest {
  text: string
  lang: 'zh' | 'en'
  strictness?: Strictness
}

// 检查响应
export interface CheckResponse {
  errors: TextError[]
  processedAt: string
}

// 用户配置
export interface UserConfig {
  apiUrl: string
  enabled: boolean
  strictness: Strictness
  autoCheck: boolean
  debounceMs: number
  minLength: number  // 最小检查长度
  checkOnBlur: boolean  // 失焦时检查
  whitelist?: string[]  // 白名单域名
  blacklist?: string[]  // 黑名单域名
}
