import { useState } from "react";
import { LogOut, Zap, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import ChangePasswordDialog from "@/components/ChangePasswordDialog";

const Header = () => {
  const { user, logout, credits } = useAuth();
  const navigate = useNavigate();
  const [showChangePw, setShowChangePw] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const creditColor =
    credits === null ? "text-muted-foreground bg-muted" :
    credits === 0 ? "text-destructive bg-destructive/10" :
    credits <= 10 ? "text-orange-600 bg-orange-100 dark:bg-orange-950 dark:text-orange-400" :
    credits <= 30 ? "text-yellow-600 bg-yellow-100 dark:bg-yellow-950 dark:text-yellow-400" :
    "text-green-600 bg-green-100 dark:bg-green-950 dark:text-green-400";

  return (
    <>
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center">
            <img src="/riskedge.png" alt="RiskEdge" className="h-10 w-auto object-contain" />
          </div>
          <div className="flex items-center gap-3">
            {user && (
              <>
                <span className="hidden sm:inline-flex items-center text-sm text-muted-foreground px-3 py-1.5 bg-muted rounded-full">
                  {user.company}
                </span>
                {/* Credits badge */}
                <span
                  className={`inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-full ${creditColor}`}
                  title="Processing credits remaining · 1 credit per invoice"
                >
                  <Zap className="w-3.5 h-3.5" />
                  {credits === null ? "—" : credits} credit{credits !== 1 ? "s" : ""}
                </span>
                {/* User menu */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex items-center gap-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                        {user.username[0].toUpperCase()}
                      </div>
                      <span className="hidden sm:block text-sm font-medium text-foreground leading-none">
                        {user.username}
                      </span>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      className="gap-2 cursor-pointer"
                      onSelect={() => setShowChangePw(true)}
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      Change password
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="gap-2 cursor-pointer text-destructive focus:text-destructive"
                      onSelect={handleLogout}
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            {!user && (
              <Button variant="ghost" size="icon" onClick={handleLogout} className="text-muted-foreground hover:text-destructive" title="Logout">
                <LogOut className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </header>

      <ChangePasswordDialog open={showChangePw} onClose={() => setShowChangePw(false)} />
    </>
  );
};

export default Header;
