(function () {
  function summarize(state) {
    const folderSelected = Number(state.folderSelected || 0) > 0;
    const folderReady = folderSelected && Number(state.folders || 0) === Number(state.folderSelected || 0);
    const folderStatus = folderReady ? "준비됨" : folderSelected
      ? Number(state.folderQuotaPaused || 0)>0 ? Number(state.folderDeviceLow || 0)>0 ? "휴대폰 공간이 부족해요 · 공간을 비우면 이어 읽어요" : "앱의 보관 한도에 도달했어요 · 준비된 자료는 계속 보내요" : Number(state.folderScanning || 0)>0 ? "자료 읽는 중" : Number(state.folderNeedsCheck || 0)>0 ? "일부 자료를 읽지 못했어요" : Number(state.folderReadable || 0) === 0 ? "권한 확인 필요" :
        Number(state.folderReadable || 0) < Number(state.folderSelected || 0) ? "일부 폴더 권한 확인 필요" : "최근 확인 지연·복구 필요"
      : "아직 고르지 않았어요";
    const notificationReady = Number(state.notificationApps || 0) > 0 &&
      state.notificationAccess === true && state.notificationListening === true;
    const notificationStatus = notificationReady ? "준비됨" :
      Number(state.notificationApps || 0) === 0 ? "업무 앱 선택 필요" :
        !state.notificationAccess ? "시스템 접근 승인 필요" : "새 알림 확인 필요";
    const smsAvailable = state.smsOriginal !== "unsupported_standard";
    const smsReadable = state.smsOriginal === "provider_readable";
    const smsReady = smsReadable && state.smsNotificationsReady === true;
    const denominator = smsAvailable ? 3 : 2;
    const connected = Number(folderReady) + Number(notificationReady) + Number(smsReady);
    const folderCoverage = folderReady || folderSelected
      ? `선택 ${state.folderSelected || 0}개 폴더 · 읽기 허용 ${state.folderReadable || 0}개 · 선택 기간에 살펴본 자료 ${state.folderObserved || 0}개 (대상 ${state.folderEligible || 0}, 제외 ${state.folderExcluded || 0}, 대기 ${state.folderPending || 0}) · 회사 연결 ${state.folderCloudReady || 0}개 · 연결 대기 ${state.folderCloudPending || 0}개${state.folderCloudAttention ? " · 연결 설정 확인 필요" : ""}`
      : "선택한 업무 폴더만 접근 · 새 연결은 지금부터 · 과거 범위는 고급 설정";
    const notificationCoverage = `선택한 앱 ${state.notificationApps || 0}개 · 업무 대화 ${state.notificationScopes || 0}개${state.notificationGapCount ? ` · 수신 공백 ${state.notificationGapCount}회` : ""}`;
    const sources = [
      { name: "업무 폴더", capability: "자동수집", permission: folderReady || Number(state.folderReadable || 0) > 0 ? "읽기 허용" : "미허용", health: folderStatus, coverage: folderCoverage },
      { name: "업무 알림", capability: "새 알림 확인", permission: state.notificationAccess ? "시스템 허용" : "미허용", health: notificationStatus, coverage: notificationCoverage },
      { name: "문자·MMS (선택)", capability: state.smsOriginal === "policy_gated" ? "삼성 문자앱 유지 · 새 문자 업무 자동 찾기" : smsAvailable ? "기본 문자앱으로 사용" : "현재 버전 미지원", permission: smsReadable || state.smsOriginal === "role_granted_unverified" ? "문자 읽기 허용" : "미허용", health: smsReady ? "문자 읽기 가능 · MMS 수신은 확인 전" : smsReadable ? "새 문자 도착 알림 확인 필요" : state.smsOriginal === "role_granted_unverified" ? "문자 읽기 확인 필요" : "아직 허용 안 함", coverage: "필요한 메시지만 시공노트에 공유할 수도 있습니다" },
      { name: "사진·개별 문서", capability: "업무 사진 폴더", permission: Number(state.photoFolders || 0)>0 ? "읽기 허용" : "폴더 선택 필요", health: Number(state.photoFolders || 0)>0 ? "선택 폴더 읽기 가능" : "아직 고르지 않았어요", coverage: "선택한 업무 폴더만 읽어요. 개별 사진은 공유로 가져와요" },
      { name: "통화녹음 파일", capability: "접근 가능한 폴더 또는 공유", permission: "별도 폴더 선택 필요", health: Number(state.recordingFolders || 0)>0 ? "선택 폴더 읽기 가능 · 음성 처리 준비 중" : "아직 고르지 않았어요", coverage: "접근 가능한 파일만 읽어요. 통화를 자동으로 녹음하지 않아요" },
    ];
    return { connected, denominator, folderReady, notificationReady, smsReady, sources };
  }
  function nextSetupStep(state) {
    const view = summarize(state);
    const tried = new Set(String(state.setupAttempted || "").split(","));
    if (!view.folderReady && !tried.has("folder")) return "folder";
    if (!view.notificationReady && !tried.has("notifications")) return "notifications";
    if (state.smsOriginal !== "unsupported_standard" && !view.smsReady && !tried.has("sms")) return "sms";
    return "review";
  }
  globalThis.SigongnoteConnectionModel = Object.freeze({ summarize, nextSetupStep });
})();
