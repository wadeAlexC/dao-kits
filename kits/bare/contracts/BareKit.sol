pragma solidity 0.4.18;

import "@aragon/os/contracts/kernel/Kernel.sol";
import "@aragon/os/contracts/acl/ACL.sol";

import "./KitBase.sol";

contract BareKit is KitBase {
    event DeployInstance(address dao);
    event InstalledApp(address appProxy, bytes32 appId);

    function BareKit(DAOFactory _fac, ENS _ens) KitBase(_fac, _ens) {}

    function newInstance(bytes32 appId, bytes32[] roles, address authorizedAddress, bytes initialize) returns (Kernel dao, ERCProxy proxy) {
        address root = msg.sender;
        dao = fac.newDAO(this);
        ACL acl = ACL(dao.acl());

        acl.createPermission(this, dao, dao.APP_MANAGER_ROLE(), this);

        // If there is no appId, an empty DAO will be created
        if (appId != bytes32(0)) {
            proxy = dao.newAppInstance(appId, latestVersionAppBase(appId)); 

            for (uint256 i = 0; i < roles.length; i++) {
                acl.createPermission(authorizedAddress, proxy, roles[i], root);
            }        

            InstalledApp(proxy, appId);
        }

        acl.grantPermission(root, dao, dao.APP_MANAGER_ROLE());
        acl.revokePermission(this, dao, dao.APP_MANAGER_ROLE());
        acl.setPermissionManager(root, dao, dao.APP_MANAGER_ROLE());

        acl.grantPermission(root, acl, acl.CREATE_PERMISSIONS_ROLE());
        acl.revokePermission(this, acl, acl.CREATE_PERMISSIONS_ROLE());
        acl.setPermissionManager(root, acl, acl.CREATE_PERMISSIONS_ROLE());

        DeployInstance(dao);
    }
}
