/**
 * 将嵌套对象拍平为 form-urlencoded 字符串
 * 图书馆服务端要求 space_category[category_id]、seats[0] 这类带中括号下标的参数形式
 */
export const FORM_CONTENT_TYPE =
  'application/x-www-form-urlencoded;charset=UTF-8';

export function buildFormBody(obj: Record<string, any>): string {
  const body = new URLSearchParams();
  const flatten = (value: any, prefix = ''): void => {
    for (const [k, v] of Object.entries(value)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) {
        v.forEach((item, i) => body.append(`${key}[${i}]`, String(item)));
      } else if (v !== null && typeof v === 'object') {
        flatten(v, key);
      } else {
        body.append(key, String(v));
      }
    }
  };
  flatten(obj);
  return body.toString();
}
