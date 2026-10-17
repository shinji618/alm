package com.bsg.alm.pda.auth

import android.content.Context
import android.content.Intent
import android.net.Uri
import com.bsg.alm.pda.core.Settings
import com.bsg.alm.pda.net.PdaAuthConfig
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import net.openid.appauth.AuthState
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.EndSessionRequest
import net.openid.appauth.ResponseTypeValues
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

/**
 * PDA 로그인(09 6.5): AppAuth로 Cognito alm-pda(공개 클라이언트)에 Authorization Code + PKCE.
 *  - 고객사 IdP는 /auth/pda-config가 이메일 도메인으로 알려준다(identity_provider)
 *  - 토큰(AuthState)은 Keystore로 암호화한 저장소에. 액세스 60분, 리프레시 24시간 = 오프라인 허용 시간
 */
class AuthManager(private val ctx: Context, private val settings: Settings) {
    private val lock = Mutex()
    private var state: AuthState? = settings.prefs.getString(KEY, null)?.let { runCatching { AuthState.jsonDeserialize(it) }.getOrNull() }
    val service by lazy { AuthorizationService(ctx) }

    val isSignedIn: Boolean get() = state?.isAuthorized == true && state?.refreshToken != null
    var userId: String?
        get() = settings.prefs.getString("userId", null)
        set(v) = settings.prefs.edit().putString("userId", v).apply()
    var displayName: String?
        get() = settings.prefs.getString("displayName", null)
        set(v) = settings.prefs.edit().putString("displayName", v).apply()

    private fun save() { settings.prefs.edit().putString(KEY, state?.jsonSerializeString()).apply() }

    /** 로그인 화면용 인텐트(Custom Tab). 결과는 handleResult로 */
    fun loginIntent(cfg: PdaAuthConfig, email: String): Intent {
        val sc = AuthorizationServiceConfiguration(Uri.parse(cfg.authorizationEndpoint), Uri.parse(cfg.tokenEndpoint), null, Uri.parse(cfg.endSessionEndpoint))
        state = AuthState(sc)
        settings.prefs.edit().putString("endSession", cfg.endSessionEndpoint).putString("clientId", cfg.clientId).apply()
        val req = AuthorizationRequest.Builder(sc, cfg.clientId, ResponseTypeValues.CODE, Uri.parse(cfg.redirectUri))
            .setScopes(cfg.scopes)
            .setLoginHint(email)
            .setAdditionalParameters(mapOf("identity_provider" to cfg.identityProvider))
            .build()
        return service.getAuthorizationRequestIntent(req)
    }

    /** 리디렉트 결과 → 코드 교환(PKCE verifier는 AppAuth가 보관) */
    suspend fun handleResult(data: Intent?): Result<Unit> {
        if (data == null) return Result.failure(IllegalStateException("Sign-in was cancelled"))
        val resp = AuthorizationResponse.fromIntent(data)
        val ex = AuthorizationException.fromIntent(data)
        val st = state ?: return Result.failure(IllegalStateException("Sign-in state lost. Try again"))
        st.update(resp, ex)
        if (resp == null) return Result.failure(ex ?: IllegalStateException("Sign-in failed"))
        return suspendCoroutine { cont ->
            service.performTokenRequest(resp.createTokenExchangeRequest()) { tr, tex ->
                st.update(tr, tex)
                save()
                cont.resume(if (tr != null) Result.success(Unit) else Result.failure(tex ?: IllegalStateException("Token exchange failed")))
            }
        }
    }

    /** 유효한 액세스 토큰(만료 전이면 그대로, 아니면 리프레시). 통신이 안 되면 실패 */
    suspend fun accessToken(): String = lock.withLock {
        val st = state ?: throw NotSignedIn()
        suspendCoroutine { cont ->
            st.performActionWithFreshTokens(service) { token, _, ex ->
                save()
                if (token != null) cont.resume(token)
                else cont.resumeWith(Result.failure(if (ex?.type == AuthorizationException.TYPE_OAUTH_TOKEN_ERROR) NotSignedIn() else (ex ?: NotSignedIn())))
            }
        }
    }

    /** 다음 호출에서 반드시 리프레시(서버가 401을 돌려준 경우) */
    fun invalidateAccess() { state?.needsTokenRefresh = true; save() }

    /** 로그아웃: 로컬 토큰 삭제. Cognito 세션 종료 URL(브라우저로 열 수 있음)을 돌려준다 */
    fun signOut(): Uri? {
        val endSession = settings.prefs.getString("endSession", null)
        val clientId = settings.prefs.getString("clientId", null)
        state = null
        settings.prefs.edit().remove(KEY).remove("userId").remove("displayName").apply()
        return if (endSession != null && clientId != null)
            Uri.parse(endSession).buildUpon().appendQueryParameter("client_id", clientId).appendQueryParameter("logout_uri", "com.bsg.alm://signed-out").build()
        else null
    }

    @Suppress("unused") private fun endSessionRequest(): EndSessionRequest? = null

    class NotSignedIn : Exception("Sign in again (session expired)")

    companion object { private const val KEY = "authState" }
}
