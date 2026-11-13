#!/bin/bash
# 데모 데이터 넣기 (로컬 미리보기용)
J='-s -H content-type:application/json -b /tmp/c -c /tmp/c'; B=${B:-http://localhost:8787}
p(){ curl $J -X POST $B$1 -d "$2" >/dev/null; }
p /api/setup '{"academy":"해솔영어학원","password":"1234"}'
p /api/admin/teacher '{"name":"김지은","password":"1111"}'
p /api/admin/teacher '{"name":"박서준","password":"2222"}'
p /api/admin/curriculum/import '{"name":"Reading Lv.2","course_id":2,"lessons":[
{"seq":1,"title":"Unit 1 My Family","content":"본문 읽기, 핵심 단어 12개","homework":"워크북 2~3쪽, 단어 암기"},
{"seq":2,"title":"Unit 2 At the Park","content":"본문 읽기, 주인공 감정 말하기","homework":"워크북 4~5쪽"},
{"seq":3,"title":"Unit 3 Rainy Day","content":"본문 읽기\n날씨 표현 정리","homework":"워크북 6~7쪽, 리딩 녹음"},
{"seq":4,"title":"Unit 4 The Lost Cat","content":"사건 순서 정리하기","homework":"워크북 8~9쪽"},
{"seq":5,"title":"Unit 5 Review","content":"Unit 1~4 복습, 단어 시험","homework":"오답 정리"}]}'
p /api/admin/curriculum/import '{"name":"Phonics 1","course_id":3,"lessons":[
{"seq":1,"title":"Short a","content":"cat, hat, map 소리 구별","homework":"단어 카드 읽기"},
{"seq":2,"title":"Short e","content":"bed, pen, red","homework":"워크북 10쪽"},
{"seq":3,"title":"Short i","content":"pig, sit, fin","homework":"워크북 12쪽"}]}'
p /api/admin/curriculum/import '{"name":"중등 문법 1","course_id":1,"lessons":[
{"seq":1,"title":"be동사","content":"현재형·과거형","homework":"문법 문제 20문항"},
{"seq":2,"title":"일반동사","content":"3인칭 단수","homework":"문법 문제, 오답 정리"},
{"seq":3,"title":"현재진행형","content":"-ing 규칙","homework":"문법 문제"}]}'
p /api/admin/class '{"name":"리딩 A반","type":"group","days":"1,2,3,4,5","time":"16:00","room":"1관","teacher_id":1,"course_id":2,"curriculum_id":1,"start_seq":1}'
p /api/admin/class '{"name":"파닉스 B반","type":"group","days":"1,3,5","time":"15:00","room":"2관","teacher_id":2,"course_id":3,"curriculum_id":2,"start_seq":1}'
p /api/admin/class '{"name":"중등 개별","type":"individual","days":"1,2,3,4,5","time":"18:00","room":"3관","teacher_id":1,"course_id":1}'
p /api/admin/students/import '{"rows":[
{"name":"김민준","class":"리딩 A반","phone":"010-2345-6789"},{"name":"이서연","class":"리딩 A반","phone":"010-3456-7890"},
{"name":"박도윤","class":"리딩 A반","phone":"010-4567-8901"},{"name":"최하은","class":"리딩 A반","phone":"010-5678-9012"},
{"name":"정예준","class":"파닉스 B반","phone":"010-6789-0123"},{"name":"강지우","class":"파닉스 B반","phone":"010-7890-1234"},
{"name":"윤시우","class":"파닉스 B반","phone":"010-8901-2345"},
{"name":"한지호","class":"중등 개별","phone":"010-9012-3456"},{"name":"오수아","class":"중등 개별","phone":"010-1234-5670"}]}'
p /api/student-curriculum '{"student_id":8,"curriculum_id":3,"start_seq":1}'
p /api/student-curriculum '{"student_id":9,"curriculum_id":3,"start_seq":2}'
# 어제 수업 기록
D1=2026-11-12
for s in 1 2 3 4; do p /api/attendance "{\"date\":\"$D1\",\"student_id\":$s,\"att\":\"present\"}"; done
p /api/record "{\"date\":\"$D1\",\"class_id\":1,\"logs\":[{\"target\":\"c1\",\"curriculum_id\":1,\"lesson_id\":2,\"seq\":2,\"today\":\"Unit 2 At the Park · 본문 읽기, 주인공 감정 말하기\",\"next\":\"Unit 3 Rainy Day\",\"homework\":\"워크북 4~5쪽\",\"repeat\":0}],\"students\":[{\"id\":1,\"hw\":\"done\",\"comment\":\"\"},{\"id\":2,\"hw\":\"done\",\"comment\":\"\"},{\"id\":3,\"hw\":\"partial\",\"comment\":\"\"},{\"id\":4,\"hw\":\"done\",\"comment\":\"\"}]}"
p /api/record "{\"date\":\"$D1\",\"class_id\":3,\"logs\":[{\"target\":\"s8\",\"curriculum_id\":3,\"lesson_id\":9,\"seq\":1,\"today\":\"be동사 · 현재형·과거형\",\"next\":\"일반동사\",\"homework\":\"문법 문제 20문항\",\"repeat\":0}],\"students\":[]}"
p /api/attendance "{\"date\":\"$D1\",\"student_id\":8,\"att\":\"present\"}"
# 오늘 일부 입력
D=2026-11-13
p /api/attendance "{\"date\":\"$D\",\"student_id\":1,\"att\":\"present\"}"
p /api/attendance "{\"date\":\"$D\",\"student_id\":2,\"att\":\"late\"}"
p /api/attendance "{\"date\":\"$D\",\"student_id\":3,\"att\":\"present\"}"
p /api/attendance "{\"date\":\"$D\",\"student_id\":4,\"att\":\"absent\",\"reason\":\"보강\"}"
p /api/record "{\"date\":\"$D\",\"class_id\":1,\"logs\":[{\"target\":\"c1\",\"curriculum_id\":1,\"lesson_id\":3,\"seq\":3,\"today\":\"Unit 3 Rainy Day · 본문 읽기 / 날씨 표현 정리\",\"next\":\"Unit 4 The Lost Cat\",\"homework\":\"워크북 6~7쪽, 리딩 녹음\",\"repeat\":0}],\"students\":[{\"id\":1,\"hw\":\"done\",\"comment\":\"날씨 표현을 문장으로 아주 잘 만들었어요.\"},{\"id\":2,\"hw\":\"missing\",\"comment\":\"\"},{\"id\":3,\"hw\":\"done\",\"comment\":\"\"},{\"id\":4,\"hw\":\"\",\"comment\":\"\"}]}"
echo seeded
