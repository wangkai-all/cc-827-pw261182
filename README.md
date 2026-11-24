# EchoSeq — 事件序列触发与背景分析

EchoSeq 是一个零第三方运行时依赖的多类别事件序列分析应用。它拟合多元 Hawkes 型条件强度，把事件强度分解为持续背景与历史事件触发贡献，并通过训练段模型选择、留出段时间重标度诊断、稳定性闸门和合成反例检查，区分：

- 持续背景强度升高；
- 自激或跨类别短期触发聚集；
- 背景突变造成的伪触发；
- 观测缺口、左边界历史缺失和时间戳舍入造成的不确定性。

> **解释边界：** `source → target` 矩阵、事件父代概率和触发贡献只表示条件强度中的统计预测关联，不是因果效应。观察性事件数据本身通常不足以识别因果方向。

## 快速开始

要求 Python 3.10+；拟合、HTTP 服务和测试只使用 Python 标准库。前端是原生 HTML/CSS/JavaScript + SVG，不需要 `npm install`。

```bash
./run.sh
# 或
python3 -m app.server --host 127.0.0.1 --port 8765
```

打开 <http://127.0.0.1:8765>。

运行测试：

```bash
python3 -m unittest discover -s tests -v
```

也可自定义地址：

```bash
HOST=0.0.0.0 PORT=8765 ./run.sh
```

## 导入格式

### JSON

最小结构：

```json
{
  "events": [
    {"t": 1.2, "category": "A"},
    {"t": 1.5, "category": "B"}
  ],
  "windows": [[0, 12], [14, 24]]
}
```

完整字段见 `examples/dataset.template.json`：

```json
{
  "name": "my-event-sequence",
  "time_unit": "hour",
  "resolution": 0.1,
  "events": [
    {"t": "2026-01-01T09:00:00", "category": "login"},
    {"t": "2026-01-01T09:04:00", "category": "ticket"}
  ],
  "windows": [
    ["2026-01-01T08:00:00", "2026-01-01T12:00:00"]
  ],
  "history_start": "2026-01-01T06:00:00"
}
```

支持的别名字段：

- 时间：`t`、`time`、`timestamp`、`datetime`、`date`、`ts`、`时间`
- 类别：`category`、`cat`、`type`、`class`、`label`、`event_type`、`类别`

数字时间保持原单位；ISO 时间会转换为相对最早时间/窗口原点的小时数。

### CSV

至少需要时间列，可选类别列：

```csv
t,category
0.20,A
0.40,B
1.10,A
```

前端会查找 `time/timestamp/datetime/date/ts/时间` 和 `category/type/class/label/类别` 等列名。CSV 不携带窗口时，应用使用“首事件到末事件”的保守推断窗口，并明确标记为 `inferred_event_span`；这不等同于真实观测窗口。

### 观测窗口与停采

`windows` 可以是 `[[start,end], ...]` 或 `[{"start": ..., "end": ...}, ...]`。窗口外时间不进入补偿器积分，因此“没有记录”不会被错误地当成“确认没有事件”。

窗口之间的区间作为停采/gap：

- 已记录事件产生的触发状态跨缺口衰减；
- 可选择稳态一阶均值松弛，近似缺口内未记录事件的期望后续贡献；
- gap 数量、时长、覆盖率和缺口后边缘事件数进入诊断。

`history_start` 之前完全未知。默认 `stationary` 左边界用稳态均值处理起始历史；也可在界面中切换为零历史敏感性版本。

窗口端点按闭区间处理，因此恰好落在 `end` 上的事件仍进入似然和诊断。训练/留出切分点若恰好是事件时间，该事件归训练段；留出作用域会排除同一显式切分点，避免重复计数。若切分点正好是训练窗口末端、而首个留出窗口在一个 gap 之后，训练末状态也会先跨该 gap 衰减/稳态松弛，再进入留出似然、残差和计数期望。

示例：

- `examples/self_excitation.json`：完整 JSON 合成数据与真值；
- `examples/events.csv`：带观测缺口场景的 CSV 事件；
- `examples/windows.json`：与该 CSV 配套的窗口；
- `examples/dataset.template.json`：可复制的导入模板。

## 模型

对目标类别 `k`，条件强度为：

\[
\lambda_k(t)=\mu_k(r(t))+\sum_j\sum_{t_i^j<t}\phi_{kj}(t-t_i^j)
\]

支持两种在训练段按 AIC 比较的归一化核形状：

- 尖峰指数核：

\[
\phi_{k\leftarrow j}(u)=\eta_{kj}\beta_{kj}e^{-\beta_{kj}u}
\]

- 延迟 Gamma(2) 核：

\[
\phi_{k\leftarrow j}(u)=\eta_{kj}\beta_{kj}^2u e^{-\beta_{kj}u}
\]

Gamma(2) 核用两个级联线性状态精确传播，不是只在界面上增加标签。两种核的 `eta` 都表示一个类别 `j` 事件期望触发的类别 `k` 直接子代期望数。

参数含义：

- `mu[k][r]`：第 `r` 个背景段中类别 `k` 的持续基线率；
- `eta[k][j]`：类别 `j` 的一个事件期望触发多少类别 `k` 的直接子代；
- `1 / beta[k][j]`：核尺度；指数核平均滞后为 `1/beta`，Gamma(2) 核平均滞后为 `2/beta`；
- `rho(eta)`：非负分支矩阵谱半径，决定多元过程稳定性。

模型选择只在训练段进行：

- Poisson 基线或 Hawkes；
- 指数核或延迟 Gamma(2) 核；
- 1–3 个等暴露背景段；
- 共同 `beta` 或 source-target 成对 `beta`；
- AIC/BIC 候选排序，界面默认选 AIC 最小者并同时展示 BIC。

训练/留出切分按**活跃观测时长**计算，而不是简单按数组位置或自然时间比例，避免长停采扭曲切分。

## 稳定性与预测闸门

当：

\[
\rho(\eta) \ge 1
\]

分支过程不是次临界过程，长期期望计数可能不收敛。应用会：

- 显示谱半径和不稳定警告；
- 拒绝长期计数推演；
- 不把超临界路径包装成可用预测。

界面中的预测区间来自标准库随机数实现的 thinning Monte Carlo，而不是伪造的解析置信区间。

## 留出段检验

选中的模型在训练段确定后，留出段不参与参数或结构选择，只用于检验：

1. **时间重标度残差**：正确模型下应近似 i.i.d. `Exp(1)`；
2. 变换后的均匀残差与 KS 检验；
3. QQ 图；
4. ACF 与 Ljung-Box 自相关检验；
5. 分类别和总事件计数检验、Pearson/χ² 统计量与 z 分数；
6. 留出区间的 Monte Carlo 计数预测区间。

成批相同时间戳无法可靠排序。应用不会按 CSV 行顺序偷偷制造零滞后父子关系，而是：

- 同戳事件用同一个 pre-jump 强度评估；
- 整批评估后统一 jump；
- 同戳间隔不进入时间重标度残差；
- 显示 tie rate、检测分辨率以及 `beta × resolution` 是否进入亚分辨率区域。

## 事件检查器

选择一个事件后，服务端重建拟合参数和索引，计算该事件发生前的：

- 总条件强度；
- 背景贡献及背景占比；
- 每个历史事件/source category 的核贡献；
- 起始稳态历史和中间停采缺口注入的期望贡献（无法指派给某个已导入事件时单独列出）；
- 归一化父代概率；
- “基线或当前核未解释部分”。

这些概率是模型依赖的归属，不是已证实的因果父边。

## 合成反例与恢复检查

Lab 中提供六类内置场景：

- `background_only`：独立 Poisson 背景；
- `self_excitation`：对角自激；
- `cross_trigger`：多类别跨类触发；
- `background_shift`：背景率突变，用于暴露把背景升高误判为触发的问题；
- `observation_gaps`：中间停采；
- `rounded_batches`：时间戳成批舍入。

合成数据携带真值时，结果页显示：

- `eta` MAE/RMSE；
- 谱半径误差；
- 背景率恢复误差；
- 假触发质量；
- 真值矩阵与估计矩阵对照。

参数恢复会受样本量、观测窗口和分辨率限制；应用保留留出检验失败和恢复不完美的结果，不会把所有 seed 都展示成成功。

## HTTP API

### `GET /api/health`

返回服务状态。

### `POST /api/analyze`

```json
{
  "dataset": {"events": [], "windows": []},
  "options": {
    "selectedCategories": ["A", "B"],
    "trainFrac": 0.7,
    "backgroundComplexity": "auto",
    "kernelComplexity": "auto",
    "boundary": "stationary",
    "gapCorrection": true,
    "enforceStable": true,
    "maxIter": 180,
    "forecastPaths": 140
  }
}
```

### `POST /api/event`

```json
{
  "dataset": {},
  "fit": {},
  "eventIndex": 20,
  "selectedCategories": ["A", "B"],
  "topN": 12
}
```

### `POST /api/synthetic`

```json
{"scenario": "background_shift", "seed": 11}
```

## 版本与隐私

“保存版本”只把当前数据摘要、选项、拟合参数和指标保存到浏览器 `localStorage` 键：

```text
echoseq.versions.v1
```

它不会上传到外部服务。版本对照展示 AIC/BIC、对数似然、参数数、谱半径、留出检验 p 值和关键矩阵差异。清除浏览器站点数据会删除这些版本。

## 目录结构

```text
app/
  hawkes.py     # 数据解析、似然、梯度、拟合、诊断、仿真
  service.py    # JSON-safe 应用服务层
  server.py     # 零依赖 HTTP 服务与静态文件路由
web/
  index.html
  styles.css
  app.js
  charts.js     # 原生 SVG 图表与 tooltip
tests/
  test_hawkes.py
examples/
```

## 验证说明

当前环境没有 Chromium/Firefox 等真实视觉浏览器。已完成：

- Python 编译检查；
- `node --check web/app.js web/charts.js`；
- 解析梯度对中心有限差分检查（含指数核与 Gamma(2) 核）；
- `python3 -m unittest discover -s tests -v`；
- HTTP API 冒烟测试；
- 临时 jsdom 页面加载、tab 切换、合成分析、事件检查器和 Lab 自检交互冒烟。

仍建议在有视觉浏览器的环境中人工检查 tooltip、键盘 focus、窄屏布局和 SVG 标签碰撞。jsdom 不验证真实布局与绘制。

## 非目标

EchoSeq 不提供：

- 因果发现或“事件 A 导致事件 B”的结论；
- 超临界模型的长期预测；
- NumPy/SciPy/pandas 依赖；
- 对随机解戳结果的静默确定性解释。
