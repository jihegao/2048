# 年级默认映射（迁移 0010）

学生的原始 `grade_level`、`grade_code` 与教师填写的 `confirmed_grade` 分开保存。个人榜和团队组别统一读取 `student_grade_resolution` 视图，按以下顺序解析：

1. `grade_level` 为 1–12 时，使用该数字年级。
2. 否则，`confirmed_grade` 已填写时，使用确认年级。
3. 否则，`grade_code` 去除开头空格后以 K 开头时，使用 K。
4. 其他情况使用 12，包括其他编码与两个原始年级字段均为 NULL 的旧记录。

未来名单导入仍要求填写年级，支持 K、1–12 和既有编码格式。导入编码时保留原始值；默认解析不会写入 `confirmed_grade`。教师可在“确认年级”列覆盖默认归属；同一编码的后续导入若不填写确认年级，会保留原有显式确认。

迁移 0010 只重建视图，不更新学生、团队或成绩。现有团队若因新映射变成跨组，仍需通过教师团队组别审计逐个处理，不自动调整成员。`practice_results` 的 `grade_at_completion` 是完成时快照；历史 `grade_source = 'legacy_unranked'` 的记录继续留在个人历史，但不进入个人榜或团队榜。
