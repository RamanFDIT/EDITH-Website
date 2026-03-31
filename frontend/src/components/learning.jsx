import {useState, useEffect} from 'react';

const UserCard = () => {
    const [userId, setUserId] = useState(1);
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    function handleNext() {
        setUserId(userId + 1);
    }
    function handlePrevious(){
        setUserId(userId - 1);
    }

    useEffect(() => {
        async function fetchData() {
            try{
                setLoading(true);
                const response = await fetch(`https://jsonplaceholder.typicode.com/users/${userId}`);
                if(!response.ok) throw new Error("Request Failed");
                const data = await response.json();
                setUser(data);
            }catch(error) {
                console.error(error);
            }finally{
                setLoading(false);
            }
        };

        fetchData();
    },[userId]);

    return(
        <div>
            {userId===1 ? <p>Disabled</p> : <button onClick = {handlePrevious}>Previous</button>}
            {userId===10 ? <p>Disabled</p> : <button onClick = {handleNext}>Next</button>}

            {loading ? <p>Laoding...</p> : 
                <div>
                    <p>Name: {user.name}</p>
                    <p>Email: {user.email}</p>
                    <p>Company: {user.company.name}</p>
                </div>
            }

        </div>
    );
}

export default UserCard;