# CVPR 2026 Compute Reporting Framework (CRF)
## Prefilled Example

---

## Section 1: Infrastructure Reporting

### 1.1 Processing Units

**CPU Information:**  
- CPU Model: *[Not specified]*  
- Number of CPU cores used: *[Not specified]*

**GPU Information:**  
- *[Placeholder for GPU details]*

**Memory and Storage:**  
- *[Placeholder for memory/storage details]*

### 1.2 Infrastructure Type

- Infrastructure type: *[Not specified]*  
- If Cloud, specify provider: *[Not specified]*  
- Instance type(s): *[Not specified]*

---

## Section 2: Task and Compute Reporting (Optional, Highly Encouraged)

> *Instructions: Report ONLY the compute needed to reproduce the specific comparison reported in your paper (your best model vs. strongest baseline on the primary dataset/task).*

### 2.1 Task Category

- Task category: *[Not specified]*  
- If Other, specify here: *[Not specified]*

### 2.2 Task Evaluation

**Performance Comparison:**  
- Performance metric name: **FID**  
- Your method - metric value: **2.01**  
- Baseline method name: **E2-Rectified Flow (Liu et al., 2023)**  
- Baseline - metric value: **4.85**  
- Performance metric percentage improvement: **58.56%**  

**Dataset Context:**  
- Primary dataset: **ImageNet-1K**

### 2.3 Compute for Reported Results

**Select Compute Metric:**  
- GPU+CPU Hours *(selected)*  
- FLOPs (Floating-Point Operations) *(optional)*

**Your Method - Model Information:**  
- Model size (number of parameters): **350M**

**Your Method - Compute Cost:**  
- Total compute (hours or FLOPs): **1000**  
- If training involved:  
  - Training set size (number of samples): **1,281,167**  
  - Training compute (hours or FLOPs): **960**  
  - Number of epochs: **400**  
  - Batch size: **2048**  
- If reporting FLOPs, also provide:  
  - FLOPs per forward pass: *[Not specified]*  
- If inference involved:  
  - Test set size (number of samples): **50,000**

### 2.4 Compute Efficiency

**Efficiency Calculation:**  
- Compute per Performance Metric Percentage Improvement:  
  - If using hours: hours per percentage point  
  - If using FLOPs: FLOPs per percentage point  
- Efficiency calculation method/reasoning: *[Not specified]*

---

## Section 3: Additional Computational Details (Optional)

### 3.1 Total Development Compute

> *Instructions: If you tracked your complete development process, report the TOTAL GPU+CPU hours spent to achieve the results in your paper, including all experiments, failed attempts, and iterations.*

- Total Development GPU+CPU hours: *[Not specified]*

**Breakdown by Development Stage (percentages sum to 100%):**  
- Hyperparameter search: % - GPU+CPU hours: *[Not specified]* - Configurations tested: *[Not specified]*  
- Ablations: % - GPU+CPU hours: *[Not specified]* - Configurations tested: *[Not specified]*  
- Inference-based development: % - GPU+CPU hours: *[Not specified]*  
- Failed experiments/debugging: % - GPU+CPU hours: *[Not specified]*  
- Other: % - GPU+CPU hours: *[Not specified]*

**Development Timeline:**  
- Project start date: *[Not specified]*  
- Final results date: *[Not specified]*  
- Total calendar time: *[Not specified]*

**Additional Context:**  
- *[Placeholder]*

### 3.2 Code Efficiency

- *[Placeholder for code efficiency details]*

---

## Section 4: W&B Log Upload (Optional)

> *We encourage submitting anonymized Weights & Biases logs to enable more precise compute and impact calculations.*

### 4.1 Privacy and Anonymization

Before submitting any W&B logs:  
1. Use the provided anonymization tool to remove all PII  
2. Review anonymized logs to ensure no sensitive information remains  
3. Only submit logs you're comfortable sharing

### 4.2 How to Anonymize Your W&B Logs

**Step 1: Install the Anonymization Tool**  
```bash
git clone https://github.com/vipavlovic/wandbanonymizer.git
cd wandbanonymizer