#!/usr/bin/env python3
"""从 zh_CN 生成繁体界面文案（zh_TW / zh_HK）。

用 OpenCC s2twp（简体 -> 台湾正体 + 台湾用词）转换 message 值，
键名、占位符（$1）、ASCII（快捷键/URL/HSK 等）原样保留。
台湾与香港暂用同一套繁体（按需求）。
"""
import json
import os
from opencc import OpenCC

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES = os.path.join(ROOT, "public", "_locales")
converter = OpenCC("s2twp")


def convert_locale(src: str, dsts: list[str]) -> None:
    with open(os.path.join(LOCALES, src, "messages.json"), encoding="utf-8") as f:
        data = json.load(f)
    out = {}
    for key, entry in data.items():
        item = dict(entry)
        if "message" in item:
            item["message"] = converter.convert(item["message"])
        out[key] = item
    for dst in dsts:
        os.makedirs(os.path.join(LOCALES, dst), exist_ok=True)
        with open(os.path.join(LOCALES, dst, "messages.json"), "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"已生成 _locales/{dst}/messages.json  ({len(out)} 条)")


if __name__ == "__main__":
    convert_locale("zh_CN", ["zh_TW", "zh_HK"])
