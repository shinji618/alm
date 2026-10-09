# 조직 정책 (Alm-OrgBaseline)

Control Tower가 기본으로 거는 컨트롤(리전 거부, CloudTrail·Config 보호) 외에 ALM이 추가하는 SCP다. `Alm-OrgBaseline` 스택이 이 폴더의 JSON을 읽어 Workloads·Security OU에 붙인다.

| 파일 | 막는 것 | 예외 |
| --- | --- | --- |
| `scp/deny-security-tamper.json` | GuardDuty·Security Hub·Access Analyzer·Inspector·Config·CloudTrail 끄기·삭제 | `AWSControlTowerExecution`, 서비스 연결 역할 |
| `scp/deny-data-destruction.json` | 감사 보관 버킷 Object Lock 변경·우회, KMS 키 삭제·비활성·정책 변경, 백업 볼트·복구 지점 삭제 | Control Tower, CDK 배포 실행 역할(키 정책 갱신), KMS는 BreakGlass |
| `scp/deny-root.json` | 루트 사용자의 모든 작업 | 없음 |

변경은 PR로만 한다. 적용 전 `cdk diff -c env=global Alm-OrgBaseline`으로 확인한다.
