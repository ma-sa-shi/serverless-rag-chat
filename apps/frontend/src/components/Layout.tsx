import { Link, NavLink, Outlet } from "react-router-dom";
import { signOut } from "../auth/session";
import { useCurrentUser } from "../auth/useCurrentUser";
import "./Layout.css";

export function Layout() {
  const { data: user } = useCurrentUser();

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
            {user && (
              <Link to={`/user/${user.userId}`}>{user.displayName}</Link>
            )}
            <button type="button" onClick={() => void signOut()}>
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
