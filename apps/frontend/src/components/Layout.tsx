import { useAuth } from "react-oidc-context";
import { Link, NavLink, Outlet } from "react-router-dom";
import { redirectToCognitoLogout } from "../auth/userManager";
import "./Layout.css";

export function Layout() {
  const auth = useAuth();

  const handleSignOut = async () => {
    // localStorageのトークンを破棄してからHosted UIのセッションを破棄する
    await auth.removeUser();
    redirectToCognitoLogout();
  };

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-header-inner">
          <span className="layout-brand">Knowledge Chat</span>
          <nav className="layout-nav">
            <NavLink to="/" end>
              チャット
            </NavLink>
            <NavLink to="/documents">ドキュメント</NavLink>
          </nav>
          <div className="layout-user">
            {auth.user && (
              <Link to={`/user/${auth.user.profile.sub}`}>
                {auth.user.profile.name}
              </Link>
            )}
            <button type="button" onClick={() => void handleSignOut()}>
              サインアウト
            </button>
          </div>
        </div>
      </header>
      <main className="layout-main">
        <div className="layout-main-inner">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
