import type { ReactNode } from "react";

interface LandingPageProps {
  onEnterChat: () => void;
}

function BrandMark() {
  return (
    <span className="landing-brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 5l5 5-5 5" />
    </svg>
  );
}

function FeatureIcon({ children }: { children: ReactNode }) {
  return (
    <span className="landing-feature-icon" aria-hidden="true">
      {children}
    </span>
  );
}

export function LandingPage({ onEnterChat }: LandingPageProps) {
  return (
    <div className="landing-shell">
      <div className="landing-noise" aria-hidden="true" />
      <header className="landing-nav">
        <a className="landing-brand" href="#top" aria-label="MonadChat 首页">
          <BrandMark />
          <span>MonadChat</span>
        </a>

        <nav className="landing-nav-links" aria-label="产品导航">
          <a href="#features">产品能力</a>
          <a href="#workflow">工作方式</a>
          <a href="#security">安全设计</a>
        </nav>

        <button className="landing-nav-cta" type="button" onClick={onEnterChat}>
          进入 Chat Room
          <ArrowIcon />
        </button>
      </header>

      <main id="top">
        <section className="landing-hero">
          <div className="landing-hero-copy">
            <div className="landing-kicker">
              <span className="landing-live-dot" />
              BUILT ON MONAD · TESTNET LIVE
            </div>
            <h1>
              私密对话，
              <span>只属于参与者。</span>
            </h1>
            <p>
              用钱包确认身份，在 Monad 上验证房间成员；消息在本地加密，
              在线优先通过 WebRTC 点对点送达。
            </p>
            <div className="landing-hero-actions">
              <button
                className="landing-primary-button"
                type="button"
                onClick={onEnterChat}
              >
                打开 Chat Room
                <ArrowIcon />
              </button>
              <a className="landing-secondary-button" href="#workflow">
                查看工作方式
              </a>
            </div>
            <div className="landing-proof-row">
              <span>无需手机号</span>
              <span>本地生成密钥</span>
              <span>链上成员验证</span>
            </div>
          </div>

          <div
            className="landing-product-visual"
            aria-label="MonadChat 产品界面示意"
          >
            <div className="visual-glow visual-glow-one" />
            <div className="visual-glow visual-glow-two" />
            <div className="visual-window">
              <div className="visual-window-bar">
                <span className="visual-window-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="visual-room-label">PRIVATE ROOM / 07</span>
                <span className="visual-secure-chip">
                  <i /> ENCRYPTED
                </span>
              </div>

              <div className="visual-room-header">
                <div>
                  <small>SECURE WORKSPACE</small>
                  <strong>Deal room</strong>
                </div>
                <div className="visual-participants">
                  <span>A</span>
                  <span>B</span>
                  <em>2 members</em>
                </div>
              </div>

              <div className="visual-chat-stage">
                <div className="visual-system-message">
                  <i>✓</i>
                  成员身份已通过 Monad 合约确认
                </div>
                <div className="visual-message visual-message-left">
                  <small>0x4e94...dd17</small>
                  <p>会话密钥已在本地完成协商。</p>
                  <time>09:41</time>
                </div>
                <div className="visual-message visual-message-right">
                  <small>YOU · 0xbe93...eaff</small>
                  <p>收到。使用加密通道继续。</p>
                  <time>09:42 · delivered</time>
                </div>
              </div>

              <div className="visual-composer">
                <span>输入加密消息…</span>
                <button type="button" tabIndex={-1} aria-hidden="true">
                  <ArrowIcon />
                </button>
              </div>
            </div>

            <div className="visual-floating-card visual-key-card">
              <span className="visual-card-icon">⌁</span>
              <div>
                <small>KEY EXCHANGE</small>
                <strong>X25519 · LOCAL</strong>
              </div>
            </div>
            <div className="visual-floating-card visual-network-card">
              <span className="visual-pulse" />
              <div>
                <small>NETWORK</small>
                <strong>PEER CONNECTED</strong>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-tech-strip" aria-label="技术能力">
          <span>WALLET IDENTITY</span>
          <i />
          <span>ONCHAIN MEMBERSHIP</span>
          <i />
          <span>X25519 + AES-GCM</span>
          <i />
          <span>WEBRTC DATACHANNEL</span>
        </section>

        <section
          className="landing-section landing-feature-section"
          id="features"
        >
          <div className="landing-section-heading">
            <span>01 / PRODUCT</span>
            <h2>把信任边界，缩小到你的设备。</h2>
            <p>
              身份、成员关系、加密与传输各自承担明确职责，减少对单一中心化服务的依赖。
            </p>
          </div>

          <div className="landing-feature-grid">
            <article className="landing-feature-card landing-feature-card-wide">
              <FeatureIcon>
                <svg viewBox="0 0 24 24">
                  <path d="M5 8.5h14v10H5zM8 8.5V6.8A4 4 0 0 1 12 3a4 4 0 0 1 4 3.8v1.7M9.5 13h5M12 13v2.5" />
                </svg>
              </FeatureIcon>
              <div>
                <span className="feature-number">01</span>
                <h3>消息先加密，再离开设备</h3>
                <p>
                  使用 X25519 协商共享密钥，并通过 AES-GCM
                  加密消息内容。私钥保留在本机存储边界内。
                </p>
              </div>
              <div className="feature-code-sample" aria-hidden="true">
                <span>PAYLOAD</span>
                <code>7f4a 91c2 0de8 3b67</code>
                <code>c941 18af 62d0 e539</code>
                <small>AUTHENTICATED · ENCRYPTED</small>
              </div>
            </article>

            <article className="landing-feature-card">
              <FeatureIcon>
                <svg viewBox="0 0 24 24">
                  <circle cx="12" cy="8" r="3.5" />
                  <path d="M5.5 20a6.5 6.5 0 0 1 13 0M4 4.5h3M5.5 3v3" />
                </svg>
              </FeatureIcon>
              <span className="feature-number">02</span>
              <h3>钱包就是身份</h3>
              <p>通过钱包签名确认控制权，无需手机号、邮箱或另一套平台账号。</p>
            </article>

            <article className="landing-feature-card">
              <FeatureIcon>
                <svg viewBox="0 0 24 24">
                  <path d="M4 8.5 12 4l8 4.5-8 4.5zM6.5 12v4.5L12 20l5.5-3.5V12" />
                </svg>
              </FeatureIcon>
              <span className="feature-number">03</span>
              <h3>房间关系写在链上</h3>
              <p>创建、加入和成员信息由 Monad 合约提供可验证的访问依据。</p>
            </article>

            <article className="landing-feature-card landing-feature-card-wide landing-feature-network">
              <div>
                <FeatureIcon>
                  <svg viewBox="0 0 24 24">
                    <circle cx="5" cy="12" r="2.5" />
                    <circle cx="19" cy="6" r="2.5" />
                    <circle cx="19" cy="18" r="2.5" />
                    <path d="m7.5 11 9-4M7.5 13l9 4" />
                  </svg>
                </FeatureIcon>
                <span className="feature-number">04</span>
                <h3>在线优先点对点传输</h3>
                <p>
                  WebRTC DataChannel 建立直连；网络环境受限时可回退至
                  TURN，中继仍只处理密文。
                </p>
              </div>
              <div className="feature-network-map" aria-hidden="true">
                <span className="network-node network-node-a">A</span>
                <span className="network-line" />
                <span className="network-status">P2P · CONNECTED</span>
                <span className="network-node network-node-b">B</span>
              </div>
            </article>
          </div>
        </section>

        <section
          className="landing-section landing-workflow-section"
          id="workflow"
        >
          <div className="landing-section-heading landing-section-heading-light">
            <span>02 / WORKFLOW</span>
            <h2>三步开始一场私密对话。</h2>
            <p>清晰、可验证，不额外制造一套账号体系。</p>
          </div>

          <div className="landing-steps">
            <article>
              <span>STEP 01</span>
              <div className="step-orbit">
                <i>01</i>
              </div>
              <h3>连接钱包</h3>
              <p>切换到 Monad Testnet，并通过钱包确认当前身份。</p>
            </article>
            <article>
              <span>STEP 02</span>
              <div className="step-orbit">
                <i>02</i>
              </div>
              <h3>创建或加入房间</h3>
              <p>创建链上房间，或输入房间邀请码加入已有空间。</p>
            </article>
            <article>
              <span>STEP 03</span>
              <div className="step-orbit">
                <i>03</i>
              </div>
              <h3>建立加密通道</h3>
              <p>验证成员并协商密钥，DataChannel 就绪后开始发送。</p>
            </article>
          </div>
        </section>

        <section
          className="landing-section landing-security-section"
          id="security"
        >
          <div className="landing-security-copy">
            <span className="landing-section-index">03 / SECURITY</span>
            <h2>
              安全不是一句口号，
              <br />
              而是一组边界。
            </h2>
            <p>
              MonadChat
              将身份验证、成员访问、密钥协商和消息传输拆分处理。任何中继服务都不应获得消息解密所需的私钥。
            </p>
            <button
              className="landing-text-button"
              type="button"
              onClick={onEnterChat}
            >
              进入测试网体验 <ArrowIcon />
            </button>
          </div>

          <div className="landing-boundary-list">
            <article>
              <span>01</span>
              <div>
                <h3>钱包边界</h3>
                <p>应用发起签名与交易请求，但不接触钱包私钥。</p>
              </div>
              <i>LOCAL</i>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>消息边界</h3>
                <p>消息正文以密文形态经过信令之外的传输层。</p>
              </div>
              <i>E2EE</i>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>网络边界</h3>
                <p>信令负责协商连接，不承担在线聊天正文存储。</p>
              </div>
              <i>P2P</i>
            </article>
          </div>
        </section>

        <section className="landing-final-cta">
          <div className="final-cta-orb" aria-hidden="true" />
          <span>MONADCHAT / PRIVATE BY DESIGN</span>
          <h2>准备好进入你的私密空间？</h2>
          <p>当前运行于 Monad Testnet，适合产品体验与功能测试。</p>
          <button
            className="landing-primary-button landing-primary-button-light"
            type="button"
            onClick={onEnterChat}
          >
            进入 Chat Room
            <ArrowIcon />
          </button>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="landing-brand">
          <BrandMark />
          <span>MonadChat</span>
        </div>
        <p>链上身份 · 本地加密 · 点对点传输</p>
        <div>
          <span>Monad Testnet</span>
          <span>Product Preview</span>
        </div>
      </footer>
    </div>
  );
}
