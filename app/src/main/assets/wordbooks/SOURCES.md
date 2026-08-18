# ReadLingo 预设词书来源

ReadLingo 的四套预设词书由 [`wordfreq`](https://github.com/rspeer/wordfreq)
3.1.1 的英语频率排序生成，每套 2000 个词条：

- `core.txt`：开放英语·核心词汇，频率排序第 1–2000。
- `intermediate.txt`：开放英语·进阶词汇，频率排序第 2001–4000。
- `advanced.txt`：开放英语·高阶词汇，频率排序第 4001–6000。
- `extended.txt`：开放英语·扩展词汇，频率排序第 6001–8000。

词条只保留小写英文字母单词，释义、音标和例句由本地词典代理按需补全。
这些词书不是 CET、TOEFL 或 IELTS 官方词表，也不代表任何考试范围或分数保证。

`wordfreq` 项目说明：代码使用 Apache-2.0，数据文件可按 CC BY-SA 4.0
再分发。对应许可证和生成说明见 [`licenses/WORDFREQ-NOTICE.md`](../../../licenses/WORDFREQ-NOTICE.md)
与 [`licenses/CC-BY-SA-4.0.txt`](../../../licenses/CC-BY-SA-4.0.txt)。

词书内容为预设学习数据；用户可以取消选择预设词书，也可以通过应用导入自己的词书。
预设词条不提供逐词删除，误添加的预设词可在“熟知词”中选择“移出”，该操作会将其标记为忽略，不会修改原始词书文件。

- [MaiMemo SSP-MMC-Plus](https://github.com/maimemo/SSP-MMC-Plus)：公开的动态间隔重复研究和数据说明。
- [FSRS Algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)：D-S-R/回忆率模型参考。
- [wordfreq](https://github.com/rspeer/wordfreq)：开放英语频率数据来源。
- [THIRD_PARTY_NOTICES.md](../../../THIRD_PARTY_NOTICES.md)：完整的第三方资源说明。
